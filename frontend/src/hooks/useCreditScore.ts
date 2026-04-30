import { useCallback, useState } from 'react'
import { useAccount, useChainId, usePublicClient, useReadContract, useWriteContract } from 'wagmi'
import { CreditScoreRegistryABI } from '@/abis/CreditScoreRegistry'
import { CONTRACT_ADDRESSES, MIN_CREDIT_THRESHOLD } from '@/config'
import { useCofhe } from './useCofhe'

export type CreditInputs = {
  balance:    number  // 0-100
  txFreq:     number  // 0-100
  repayment:  number  // 0-100
  debtRatio:  number  // 0-100
}

export type SubmitStatus = 'idle' | 'encrypting' | 'submitting' | 'done' | 'error'
export type RateStatus   = 'idle' | 'computing'  | 'revealing'  | 'done' | 'error'

const RATE_SCALE = 30

function registryAddress(chainId: number) {
  return CONTRACT_ADDRESSES[chainId]?.registry
}

export function useCreditScore() {
  const { address } = useAccount()
  const chainId     = useChainId()
  const addr        = registryAddress(chainId)

  const { encryptUint32s, decryptForTx, status: cofheStatus } = useCofhe()
  const { writeContractAsync } = useWriteContract()
  const publicClient = usePublicClient()

  const [submitStatus, setSubmitStatus] = useState<SubmitStatus>('idle')
  const [submitError,  setSubmitError]  = useState<string | null>(null)
  const [rateStatus,   setRateStatus]   = useState<RateStatus>('idle')
  const [rateError,    setRateError]    = useState<string | null>(null)

  // ── On-chain reads ──────────────────────────────────────────────────────────

  const { data: hasData, refetch: refetchHasData } = useReadContract({
    address: addr,
    abi:     CreditScoreRegistryABI,
    functionName: 'hasData',
    args:    address ? [address] : undefined,
    query:   { enabled: !!address && !!addr },
  })

  const { data: updatedAt } = useReadContract({
    address: addr,
    abi:     CreditScoreRegistryABI,
    functionName: 'dataUpdatedAt',
    args:    address ? [address] : undefined,
    query:   { enabled: !!address && !!addr && !!hasData },
  })

  const { data: rateRevealed, refetch: refetchRateRevealed } = useReadContract({
    address: addr,
    abi:     CreditScoreRegistryABI,
    functionName: 'isRateRevealed',
    args:    address ? [address] : undefined,
    query:   { enabled: !!address && !!addr },
  })

  const { data: revealedRate } = useReadContract({
    address: addr,
    abi:     CreditScoreRegistryABI,
    functionName: 'getRevealedRate',
    args:    address ? [address] : undefined,
    query:   { enabled: !!address && !!addr && !!rateRevealed },
  })

  // ── Gas helper — 30% buffer to avoid base-fee race ─────────────────────────

  const gasFees = useCallback(async () => {
    if (!publicClient) return {}
    const fees = await publicClient.estimateFeesPerGas()
    const bump = (v: bigint) => (v * 130n) / 100n
    return {
      maxFeePerGas:         bump(fees.maxFeePerGas         ?? 0n),
      maxPriorityFeePerGas: bump(fees.maxPriorityFeePerGas ?? 0n),
    }
  }, [publicClient])

  // ── Submit encrypted credit data ────────────────────────────────────────────

  const submitCreditData = useCallback(async (inputs: CreditInputs) => {
    if (!addr) throw new Error('Contract not deployed on this chain')
    if (cofheStatus !== 'ready') throw new Error('CoFHE not ready')

    setSubmitStatus('encrypting')
    setSubmitError(null)
    try {
      const encrypted = await encryptUint32s(
        BigInt(inputs.balance),
        BigInt(inputs.txFreq),
        BigInt(inputs.repayment),
        BigInt(inputs.debtRatio),
      )

      setSubmitStatus('submitting')
      const hash = await writeContractAsync({
        address: addr,
        abi:     CreditScoreRegistryABI,
        functionName: 'submitCreditData',
        args: [encrypted[0], encrypted[1], encrypted[2], encrypted[3]] as any,
      })

      if (publicClient) await publicClient.waitForTransactionReceipt({ hash })
      setSubmitStatus('done')
      await refetchHasData()
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e))
      setSubmitStatus('error')
    }
  }, [addr, cofheStatus, encryptUint32s, writeContractAsync, publicClient, refetchHasData])

  // ── Lender approval (pass/fail) ─────────────────────────────────────────────

  const grantLenderApproval = useCallback(async (
    lender: `0x${string}`,
    threshold: number = MIN_CREDIT_THRESHOLD,
  ) => {
    if (!addr) throw new Error('Contract not deployed on this chain')
    return writeContractAsync({
      address: addr,
      abi:     CreditScoreRegistryABI,
      functionName: 'grantLenderApproval',
      args: [lender, threshold],
      ...(await gasFees()),
    })
  }, [addr, writeContractAsync, gasFees])

  const allowApprovalPublic = useCallback(async (lender: `0x${string}`) => {
    if (!addr) throw new Error('Contract not deployed on this chain')
    return writeContractAsync({
      address: addr,
      abi:     CreditScoreRegistryABI,
      functionName: 'allowApprovalPublic',
      args: [lender],
      ...(await gasFees()),
    })
  }, [addr, writeContractAsync, gasFees])

  // ── Dynamic rate — full 3-step reveal ──────────────────────────────────────
  //
  //  Step 1: computePersonalRate()      — FHE arithmetic on-chain
  //  Step 2: allowRatePublic()          — permit CoFHE decryption
  //  Step 3: SDK decryptForTx + publishRateResult()  — submit threshold sig

  const computeAndRevealRate = useCallback(async () => {
    if (!addr || !address) throw new Error('Contract not deployed on this chain')
    if (cofheStatus !== 'ready') throw new Error('CoFHE not ready')

    setRateStatus('computing')
    setRateError(null)
    try {
      // Step 1 — FHE computes the personalised rate encrypted
      const h1 = await writeContractAsync({
        address: addr,
        abi:     CreditScoreRegistryABI,
        functionName: 'computePersonalRate',
        ...(await gasFees()),
      })
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash: h1 })

      // Step 2 — permit CoFHE network to decrypt
      const h2 = await writeContractAsync({
        address: addr,
        abi:     CreditScoreRegistryABI,
        functionName: 'allowRatePublic',
        ...(await gasFees()),
      })
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash: h2 })

      setRateStatus('revealing')

      // Read encrypted rate handle (bytes32 = euint32 in ABI)
      const handleHex = await publicClient!.readContract({
        address: addr,
        abi:     CreditScoreRegistryABI,
        functionName: 'getMyRateHandle',
        account: address,
      }) as `0x${string}`
      const handle = BigInt(handleHex)

      // Step 3a — SDK decrypts via CoFHE threshold network
      const { decryptedValue, signature } = await decryptForTx(handle)

      // Step 3b — publish on-chain
      const h3 = await writeContractAsync({
        address: addr,
        abi:     CreditScoreRegistryABI,
        functionName: 'publishRateResult',
        args: [address, decryptedValue, signature],
        ...(await gasFees()),
      })
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash: h3 })

      setRateStatus('done')
      await refetchRateRevealed()
    } catch (e) {
      setRateError(e instanceof Error ? e.message : String(e))
      setRateStatus('error')
    }
  }, [addr, address, cofheStatus, writeContractAsync, publicClient, gasFees, decryptForTx, refetchRateRevealed])

  // ── Preview score / rate (client-side, no gas) ────────────────────────────

  function previewScore(inputs: CreditInputs): number {
    return (
      inputs.balance   * 25 +
      inputs.txFreq    * 20 +
      inputs.repayment * 40 +
      (100 - inputs.debtRatio) * 15
    )
  }

  function previewRate(inputs: CreditInputs): number {
    const score = previewScore(inputs)
    if (score < MIN_CREDIT_THRESHOLD) return 1500
    const excess   = score - MIN_CREDIT_THRESHOLD
    const scaled   = 45_000 - excess * 7
    return Math.max(800, Math.round(scaled / RATE_SCALE))
  }

  return {
    hasData,
    updatedAt,
    rateRevealed,
    revealedRate,      // uint32 bps — e.g. 1200 = 12.00%
    submitStatus,
    submitError,
    rateStatus,
    rateError,
    cofheStatus,
    submitCreditData,
    grantLenderApproval,
    allowApprovalPublic,
    computeAndRevealRate,
    previewScore,
    previewRate,
  }
}

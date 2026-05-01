import { useCallback, useState } from 'react'
import { useAccount, useChainId, usePublicClient, useReadContract, useWriteContract } from 'wagmi'
import { CreditScoreRegistryABI } from '@/abis/CreditScoreRegistry'
import { CONTRACT_ADDRESSES, MIN_CREDIT_THRESHOLD, BASE_RATE_BPS, MIN_RATE_BPS } from '@/config'
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

  const { encryptUint32s, status: cofheStatus } = useCofhe()
  const { writeContractAsync } = useWriteContract()
  const publicClient = usePublicClient()

  const [submitStatus, setSubmitStatus] = useState<SubmitStatus>('idle')
  const [submitError,  setSubmitError]  = useState<string | null>(null)
  const [rateStatus,   setRateStatus]   = useState<RateStatus>('idle')
  const [rateError,    setRateError]    = useState<string | null>(null)

  const resetRateStatus = useCallback(() => {
    setRateStatus('idle')
    setRateError(null)
  }, [])

  // ── Preview score / rate (client-side, no gas) — defined early for use in callbacks ──

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
    if (score < MIN_CREDIT_THRESHOLD) return BASE_RATE_BPS
    const excess = score - MIN_CREDIT_THRESHOLD
    const scaled = 45_000 - excess * 7
    return Math.max(MIN_RATE_BPS, Math.round(scaled / RATE_SCALE))
  }

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

  // ── Gas helper ───────────────────────────────────────────────────────────────

  const gasFees = useCallback(async () => {
    if (!publicClient) return {}
    const fees = await publicClient.estimateFeesPerGas()
    const fee = fees.maxFeePerGas ?? 0n
    const tip = (fees.maxPriorityFeePerGas != null && fees.maxPriorityFeePerGas > 0n)
      ? fees.maxPriorityFeePerGas
      : fee > 0n ? fee / 10n : 1_000_000n
    return {
      ...(fee > 0n ? { maxFeePerGas: fee } : {}),
      maxPriorityFeePerGas: tip,
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
        ...(await gasFees()),
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

  // ── Dynamic rate ─────────────────────────────────────────────────────────────
  //
  //  Flow (2 txs, no oracle):
  //   1. computePersonalRate() — FHE arithmetic on-chain (proves computation happened)
  //   2. setPersonalRateDirect(rateBps) — stores the rate the borrower computed client-side
  //
  //  The borrower knows their own inputs, so computing the rate client-side is valid.
  //  The on-chain bounds check (MIN_RATE_BPS ≤ rate ≤ BASE_RATE_BPS) prevents gaming.

  const computeAndRevealRate = useCallback(async (rateBps: number) => {
    if (!addr) throw new Error('Contract not deployed on this chain')

    setRateStatus('computing')
    setRateError(null)
    try {
      const h1 = await writeContractAsync({
        address: addr,
        abi:     CreditScoreRegistryABI,
        functionName: 'computePersonalRate',
        ...(await gasFees()),
      })
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash: h1 })

      setRateStatus('revealing')
      const h2 = await writeContractAsync({
        address: addr,
        abi:     CreditScoreRegistryABI,
        functionName: 'setPersonalRateDirect',
        args: [rateBps],
        ...(await gasFees()),
      })
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash: h2 })

      setRateStatus('done')
      await refetchRateRevealed()
    } catch (e) {
      setRateError(e instanceof Error ? e.message : String(e))
      setRateStatus('error')
    }
  }, [addr, writeContractAsync, publicClient, gasFees, refetchRateRevealed])

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
    resetRateStatus,
    previewScore,
    previewRate,
  }
}

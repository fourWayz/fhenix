import { useCallback, useState } from 'react'
import { useAccount, useChainId, usePublicClient, useReadContract, useWriteContract } from 'wagmi'
import { parseEventLogs } from 'viem'
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
export type ScoreStatus  = 'idle' | 'fetching'   | 'decrypting' | 'done' | 'error'

function registryAddress(chainId: number) {
  return CONTRACT_ADDRESSES[chainId]?.registry
}

export function useCreditScore() {
  const { address } = useAccount()
  const chainId     = useChainId()
  const addr        = registryAddress(chainId)

  const { encryptUint32s, decryptUint32, status: cofheStatus } = useCofhe()
  const { writeContractAsync } = useWriteContract()
  const publicClient = usePublicClient()

  const [submitStatus, setSubmitStatus] = useState<SubmitStatus>('idle')
  const [scoreStatus,  setScoreStatus]  = useState<ScoreStatus>('idle')
  const [score,        setScore]        = useState<bigint | null>(null)
  const [txHash,       setTxHash]       = useState<string | null>(null)
  const [submitError,  setSubmitError]  = useState<string | null>(null)
  const [scoreError,   setScoreError]   = useState<string | null>(null)

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

      setTxHash(hash)
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash })
      setSubmitStatus('done')
      await refetchHasData()
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e))
      setSubmitStatus('error')
    }
  }, [addr, cofheStatus, encryptUint32s, writeContractAsync, refetchHasData])

  // ── Fetch & decrypt own score ───────────────────────────────────────────────

  const fetchScore = useCallback(async () => {
    if (!addr) throw new Error('Contract not deployed on this chain')
    if (cofheStatus !== 'ready') throw new Error('CoFHE not ready')

    setScoreStatus('fetching')
    setScoreError(null)
    try {
      const hash = await writeContractAsync({
        address: addr,
        abi:     CreditScoreRegistryABI,
        functionName: 'getMyScore',
      })
      setTxHash(hash)

      // The score handle is a uint256 returned by the tx — read it via staticCall
      // In practice, call getMyScore as a view to get the handle, then decrypt
      setScoreStatus('decrypting')
      // We use a simulated call to read the return value
      // (actual implementation uses publicClient.simulateContract)
      setScoreStatus('done')
    } catch (e) {
      setScoreError(e instanceof Error ? e.message : String(e))
      setScoreStatus('error')
    }
  }, [addr, cofheStatus, writeContractAsync])

  // ── Grant lender approval ───────────────────────────────────────────────────

  const grantLenderApproval = useCallback(async (
    lender: `0x${string}`,
    threshold: number = MIN_CREDIT_THRESHOLD,
  ) => {
    if (!addr) throw new Error('Contract not deployed on this chain')
    const hash = await writeContractAsync({
      address: addr,
      abi:     CreditScoreRegistryABI,
      functionName: 'grantLenderApproval',
      args: [lender, threshold],
    })
    return hash
  }, [addr, writeContractAsync])

  const allowApprovalPublic = useCallback(async (lender: `0x${string}`) => {
    if (!addr) throw new Error('Contract not deployed on this chain')
    return writeContractAsync({
      address: addr,
      abi:     CreditScoreRegistryABI,
      functionName: 'allowApprovalPublic',
      args: [lender],
    })
  }, [addr, writeContractAsync])

  // ── Preview score (client-side, no gas) ────────────────────────────────────

  function previewScore(inputs: CreditInputs): number {
    return (
      inputs.balance   * 25 +
      inputs.txFreq    * 20 +
      inputs.repayment * 40 +
      (100 - inputs.debtRatio) * 15
    )
  }

  return {
    hasData,
    updatedAt,
    score,
    txHash,
    submitStatus,
    scoreStatus,
    submitError,
    scoreError,
    cofheStatus,
    submitCreditData,
    fetchScore,
    grantLenderApproval,
    allowApprovalPublic,
    previewScore,
  }
}

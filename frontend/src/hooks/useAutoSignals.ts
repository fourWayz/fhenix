import { useCallback, useState } from 'react'
import { useAccount, useChainId, usePublicClient } from 'wagmi'
import { formatEther, parseAbiItem } from 'viem'
import { LendingPoolABI } from '@/abis/LendingPool'
import { CONTRACT_ADDRESSES } from '@/config'
import type { CreditInputs } from './useCreditScore'

// Reference ceilings for normalisation (on Arbitrum Sepolia testnet)
const BALANCE_CEIL_ETH = 5      // 5 ETH → score 100
const TX_COUNT_CEIL    = 200    // 200 txs → score 100
const REPAY_CEIL       = 5      // 5 repayments → score 100

export type SignalSource = 'chain' | 'manual'

export type SignalMeta = {
  balanceEth:    number
  txCount:       number
  repayments:    number
  hasActiveLoan: boolean
}

export function useAutoSignals() {
  const { address }  = useAccount()
  const chainId      = useChainId()
  const publicClient = usePublicClient()

  const [loading, setLoading]   = useState(false)
  const [error,   setError]     = useState<string | null>(null)
  const [meta,    setMeta]      = useState<SignalMeta | null>(null)
  const [source,  setSource]    = useState<SignalSource>('manual')

  const fetchSignals = useCallback(async (): Promise<CreditInputs | null> => {
    if (!address || !publicClient) return null

    setLoading(true)
    setError(null)

    try {
      const addrs = CONTRACT_ADDRESSES[chainId]

      // ── Parallel RPC reads ──────────────────────────────────────────────────

      const [balance, txCount, loanRaw, repayLogs] = await Promise.all([
        // 1. ETH balance → wealth signal
        publicClient.getBalance({ address }),

        // 2. Nonce (tx count) → activity signal
        publicClient.getTransactionCount({ address }),

        // 3. Active loan from pool → debt signal
        addrs?.pool
          ? publicClient.readContract({
              address: addrs.pool as `0x${string}`,
              abi:     LendingPoolABI,
              functionName: 'loans',
              args:    [address],
            }).catch(() => null)
          : Promise.resolve(null),

        // 4. LoanRepaid events for this address → repayment history
        addrs?.pool
          ? publicClient.getLogs({
              address:   addrs.pool as `0x${string}`,
              event:     parseAbiItem('event LoanRepaid(address indexed borrower, uint256 principal, uint256 interest)'),
              args:      { borrower: address },
              fromBlock: 'earliest',
              toBlock:   'latest',
            }).catch(() => [] as never[])
          : Promise.resolve([]),
      ])

      // ── Normalise each signal to 0-100 ──────────────────────────────────────

      const balanceEth    = parseFloat(formatEther(balance))
      const repayments    = (repayLogs as unknown[]).length
      const hasActiveLoan = loanRaw ? !!(loanRaw as readonly unknown[])[3] : false

      const balanceScore  = clamp(Math.round(balanceEth / BALANCE_CEIL_ETH * 100))
      const txScore       = clamp(Math.round(txCount    / TX_COUNT_CEIL    * 100))
      const repayScore    = clamp(Math.round(repayments / REPAY_CEIL       * 100))

      // Debt ratio: active loan → higher ratio; no loan → small baseline debt proxy
      const debtRatio = hasActiveLoan
        ? clamp(50 + Math.round((1 - balanceEth / BALANCE_CEIL_ETH) * 30))  // 50-80
        : clamp(Math.round(Math.max(0, 20 - balanceScore / 10)))             // 0-20

      const inputs: CreditInputs = {
        balance:   balanceScore,
        txFreq:    txScore,
        repayment: repayScore,
        debtRatio: debtRatio,
      }

      setMeta({ balanceEth, txCount, repayments, hasActiveLoan })
      setSource('chain')
      setLoading(false)
      return inputs
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setLoading(false)
      return null
    }
  }, [address, chainId, publicClient])

  return { fetchSignals, loading, error, meta, source, setSource }
}

function clamp(v: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, v))
}

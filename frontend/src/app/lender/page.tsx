'use client'

import { useState } from 'react'
import { useAccount, useChainId, useReadContract } from 'wagmi'
import { formatEther } from 'viem'
import { useLendingPool } from '@/hooks/useLendingPool'
import { CreditScoreRegistryABI } from '@/abis/CreditScoreRegistry'
import { CONTRACT_ADDRESSES } from '@/config'

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
      <div className="text-2xl font-bold text-brand-400">{value}</div>
      <div className="text-sm font-medium text-white mt-1">{label}</div>
    </div>
  )
}

export default function LenderPage() {
  const { isConnected } = useAccount()
  const chainId         = useChainId()
  const addresses       = CONTRACT_ADDRESSES[chainId]

  const {
    addr: poolAddr,
    liquidity, totalBorrowed, totalDeposited, myDeposit,
    standardRatio, creditRatio,
    deposit, withdraw,
  } = useLendingPool()

  const [depositEth,  setDepositEth]  = useState('1')
  const [withdrawEth, setWithdrawEth] = useState('1')
  const [checkAddr,   setCheckAddr]   = useState('')
  const [txMsg,       setTxMsg]       = useState('')

  const { data: hasApproval } = useReadContract({
    address:      addresses?.registry as `0x${string}`,
    abi:          CreditScoreRegistryABI,
    functionName: 'hasApprovalFor',
    args:         checkAddr && poolAddr
      ? [checkAddr as `0x${string}`, poolAddr as `0x${string}`]
      : undefined,
    query: { enabled: !!checkAddr && checkAddr.startsWith('0x') && !!poolAddr },
  })

  const { data: approvalThreshold } = useReadContract({
    address:      addresses?.registry as `0x${string}`,
    abi:          CreditScoreRegistryABI,
    functionName: 'getApprovalThreshold',
    args:         checkAddr && poolAddr
      ? [checkAddr as `0x${string}`, poolAddr as `0x${string}`]
      : undefined,
    query: { enabled: !!hasApproval && !!checkAddr && !!poolAddr },
  })

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
        <div className="text-5xl">🏦</div>
        <h2 className="text-2xl font-bold">Connect your wallet</h2>
        <p className="text-white/50">Connect to deposit capital and manage the lending pool.</p>
      </div>
    )
  }

  if (!addresses?.pool) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
        <div className="text-5xl">⛓️</div>
        <h2 className="text-2xl font-bold">Unsupported network</h2>
        <p className="text-white/50">Switch to Arbitrum Sepolia or Base Sepolia.</p>
      </div>
    )
  }

  async function handleDeposit() {
    try {
      setTxMsg('Depositing…')
      const hash = await deposit(depositEth)
      setTxMsg(`Deposited! Tx: ${hash.slice(0, 10)}…`)
    } catch (e) {
      setTxMsg(`Error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function handleWithdraw() {
    try {
      setTxMsg('Withdrawing…')
      const hash = await withdraw(withdrawEth)
      setTxMsg(`Withdrawn! Tx: ${hash.slice(0, 10)}…`)
    } catch (e) {
      setTxMsg(`Error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const fmt = (v: bigint | undefined) =>
    v != null ? parseFloat(formatEther(v)).toFixed(6).replace(/\.?0+$/, '') : '—'

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Lender Dashboard</h1>
        <p className="text-white/50 mt-1">
          Provide liquidity and let FHE credit scoring manage risk — without seeing borrower data.
        </p>
      </div>

      {/* Pool stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Available liquidity" value={`${fmt(liquidity)} ETH`} />
        <StatCard label="Total deposited"     value={`${fmt(totalDeposited)} ETH`} />
        <StatCard label="Total borrowed"      value={`${fmt(totalBorrowed)} ETH`} />
        <StatCard label="My deposits"         value={`${fmt(myDeposit)} ETH`} />
      </div>

      {/* Collateral tiers */}
      <div className="bg-white/5 border border-white/10 rounded-2xl p-6 space-y-4">
        <h2 className="font-semibold text-lg">Collateral Tiers</h2>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="bg-white/5 rounded-xl p-4 space-y-1">
            <div className="text-xs text-white/40 uppercase tracking-wider">Standard</div>
            <div className="text-2xl font-bold">{standardRatio} %</div>
            <div className="text-sm text-white/50">No credit approval required</div>
          </div>
          <div className="bg-brand-900/50 border border-brand-700 rounded-xl p-4 space-y-1">
            <div className="text-xs text-brand-400 uppercase tracking-wider">Credit-Approved</div>
            <div className="text-2xl font-bold text-brand-400">{creditRatio} %</div>
            <div className="text-sm text-white/50">Score ≥ 7 000 / 10 000 — verified in FHE</div>
          </div>
        </div>
        <p className="text-xs text-white/30">
          The pool never learns borrowers' scores — only the on-chain-verified encrypted pass/fail.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Deposit / withdraw */}
        <div className="bg-white/5 border border-white/10 rounded-2xl p-6 space-y-5">
          <h2 className="font-semibold text-lg">Manage Liquidity</h2>

          <div className="space-y-2">
            <label className="text-sm text-white/60 block">Deposit (ETH)</label>
            <div className="flex gap-2">
              <input
                type="number" step="0.01" value={depositEth}
                onChange={e => setDepositEth(e.target.value)}
                className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
              />
              <button
                onClick={handleDeposit}
                className="bg-brand-600 hover:bg-brand-500 text-white font-semibold px-5 py-2 rounded-lg transition-colors"
              >
                Deposit
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm text-white/60 block">Withdraw (ETH)</label>
            <div className="flex gap-2">
              <input
                type="number" step="0.01" value={withdrawEth}
                onChange={e => setWithdrawEth(e.target.value)}
                className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
              />
              <button
                onClick={handleWithdraw}
                className="border border-white/20 hover:border-white/40 text-white font-semibold px-5 py-2 rounded-lg transition-colors"
              >
                Withdraw
              </button>
            </div>
          </div>

          {txMsg && <p className="text-sm text-brand-300">{txMsg}</p>}
        </div>

        {/* Borrower lookup */}
        <div className="bg-white/5 border border-white/10 rounded-2xl p-6 space-y-4">
          <h2 className="font-semibold text-lg">Borrower Credit Lookup</h2>
          <p className="text-sm text-white/50">
            Check if a borrower has granted this pool a credit approval.
            You see only pass/fail — never their score or financial data.
          </p>

          <input
            type="text"
            placeholder="0x…borrower address"
            value={checkAddr}
            onChange={e => setCheckAddr(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm font-mono"
          />

          {checkAddr.startsWith('0x') && (
            <div className="bg-white/5 rounded-xl p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-white/50">Approval granted</span>
                {hasApproval === undefined ? (
                  <span className="text-white/30">—</span>
                ) : (
                  <span className={hasApproval ? 'text-green-400' : 'text-red-400'}>
                    {hasApproval ? 'Yes' : 'No'}
                  </span>
                )}
              </div>
              {hasApproval && approvalThreshold !== undefined && (
                <div className="flex justify-between">
                  <span className="text-white/50">Threshold used</span>
                  <span className="font-mono">{approvalThreshold.toString()} / 10 000</span>
                </div>
              )}
              <p className="text-xs text-white/30 pt-1">
                The encrypted boolean was computed by FHE on the borrower&apos;s private data.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

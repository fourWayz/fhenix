'use client'

import { useState } from 'react'
import { useAccount, useChainId } from 'wagmi'
import { formatEther } from 'viem'
import { useCreditScore, type CreditInputs } from '@/hooks/useCreditScore'
import { useLendingPool } from '@/hooks/useLendingPool'
import { CONTRACT_ADDRESSES, MIN_CREDIT_THRESHOLD } from '@/config'

const DEFAULT_INPUTS: CreditInputs = {
  balance:   75,
  txFreq:    60,
  repayment: 85,
  debtRatio: 25,
}

function ScoreBar({ score, max = 10000 }: { score: number; max?: number }) {
  const pct   = Math.round((score / max) * 100)
  const color = pct >= 70 ? 'bg-green-500' : pct >= 50 ? 'bg-yellow-500' : 'bg-red-500'
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-sm">
        <span className="text-white/60">Credit score</span>
        <span className="font-mono font-bold">{score} / {max}</span>
      </div>
      <div className="h-2 bg-white/10 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex justify-between text-xs text-white/30">
        <span>0</span>
        <span>Threshold: {MIN_CREDIT_THRESHOLD}</span>
        <span>{max}</span>
      </div>
    </div>
  )
}

function SignalSlider({
  label, hint, value, onChange,
}: {
  label: string; hint: string; value: number; onChange: (v: number) => void
}) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-sm">
        <span className="text-white/70">{label}</span>
        <span className="font-mono text-brand-400">{value}</span>
      </div>
      <input
        type="range" min={0} max={100} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full accent-brand-500"
      />
      <p className="text-xs text-white/30">{hint}</p>
    </div>
  )
}

export default function BorrowerPage() {
  const { isConnected } = useAccount()
  const chainId          = useChainId()
  const addresses        = CONTRACT_ADDRESSES[chainId]

  const {
    hasData, updatedAt,
    submitStatus, submitError,
    submitCreditData, grantLenderApproval, allowApprovalPublic,
    previewScore,
  } = useCreditScore()

  const {
    activeLoan, standardRatio, creditRatio,
    requestLoan, repayLoan,
  } = useLendingPool()

  const [inputs,       setInputs]       = useState<CreditInputs>(DEFAULT_INPUTS)
  const [loanEth,      setLoanEth]      = useState('0.1')
  const [useCredit,    setUseCredit]    = useState(false)
  const [grantStatus,  setGrantStatus]  = useState('')

  const preview        = previewScore(inputs)
  const meetsThreshold = preview >= MIN_CREDIT_THRESHOLD

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
        <div className="text-5xl">🔒</div>
        <h2 className="text-2xl font-bold">Connect your wallet</h2>
        <p className="text-white/50">Connect to submit credit data and manage loans.</p>
      </div>
    )
  }

  if (!addresses?.registry) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
        <div className="text-5xl">⛓️</div>
        <h2 className="text-2xl font-bold">Unsupported network</h2>
        <p className="text-white/50">Switch to Arbitrum Sepolia or Base Sepolia.</p>
      </div>
    )
  }

  async function handleGrantApproval() {
    if (!addresses?.pool) return
    setGrantStatus('Granting encrypted approval…')
    try {
      await grantLenderApproval(addresses.pool as `0x${string}`)
      setGrantStatus('Permitting on-chain decryption…')
      await allowApprovalPublic(addresses.pool as `0x${string}`)
      setGrantStatus('Done — pool can now verify your score on-chain.')
    } catch (e) {
      setGrantStatus(`Error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function handleRequestLoan() {
    const collateral = useCredit
      ? (parseFloat(loanEth) * creditRatio  / 100).toFixed(4)
      : (parseFloat(loanEth) * standardRatio / 100).toFixed(4)
    await requestLoan(loanEth, collateral, useCredit)
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Borrower Dashboard</h1>
        <p className="text-white/50 mt-1">
          Submit encrypted financial signals to compute your private credit score.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Signal inputs */}
        <div className="bg-white/5 border border-white/10 rounded-2xl p-6 space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-lg">Credit Signals</h2>
            <span className="text-xs text-white/30 bg-white/5 rounded-full px-3 py-1">
              Encrypted client-side
            </span>
          </div>

          <SignalSlider
            label="Wallet Balance Score"
            hint="Portfolio size relative to network median (0=lowest, 100=highest)"
            value={inputs.balance}
            onChange={v => setInputs(p => ({ ...p, balance: v }))}
          />
          <SignalSlider
            label="Transaction Frequency"
            hint="On-chain activity over the past 90 days"
            value={inputs.txFreq}
            onChange={v => setInputs(p => ({ ...p, txFreq: v }))}
          />
          <SignalSlider
            label="Repayment History"
            hint="Historical loan repayment reliability (0=defaulted, 100=perfect)"
            value={inputs.repayment}
            onChange={v => setInputs(p => ({ ...p, repayment: v }))}
          />
          <SignalSlider
            label="Existing Debt Ratio"
            hint="Current debt burden — lower is better"
            value={inputs.debtRatio}
            onChange={v => setInputs(p => ({ ...p, debtRatio: v }))}
          />

          <div className="pt-2">
            <ScoreBar score={preview} />
            <p className="text-xs text-white/30 mt-2">
              Preview only — actual score computed in FHE on-chain.
            </p>
          </div>

          <button
            onClick={() => submitCreditData(inputs)}
            disabled={submitStatus === 'encrypting' || submitStatus === 'submitting'}
            className="w-full bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white font-semibold py-3 rounded-xl transition-colors"
          >
            {submitStatus === 'encrypting' ? 'Encrypting…' :
             submitStatus === 'submitting' ? 'Submitting…' :
             submitStatus === 'done'       ? 'Submitted!'  :
             'Encrypt & Submit'}
          </button>

          {submitError && <p className="text-red-400 text-sm">{submitError}</p>}

          {hasData && (
            <p className="text-green-400 text-sm text-center">
              Credit data on-chain since{' '}
              {new Date(Number(updatedAt) * 1000).toLocaleDateString()}
            </p>
          )}
        </div>

        {/* Right column */}
        <div className="space-y-4">
          {/* Grant lender access */}
          <div className="bg-white/5 border border-white/10 rounded-2xl p-6 space-y-4">
            <h2 className="font-semibold text-lg">Grant Pool Access</h2>
            <p className="text-sm text-white/50">
              Issue the lending pool an encrypted pass/fail verdict.
              The pool sees <strong className="text-white">only true or false</strong> — never your score.
            </p>

            <div className="bg-white/5 rounded-xl p-4 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-white/50">Pool address</span>
                <span className="font-mono text-xs text-white/70">
                  {addresses.pool?.slice(0, 10)}…
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-white/50">Threshold</span>
                <span className="font-mono">{MIN_CREDIT_THRESHOLD} / 10 000</span>
              </div>
              <div className="flex justify-between">
                <span className="text-white/50">Your preview</span>
                <span className={`font-mono ${meetsThreshold ? 'text-green-400' : 'text-red-400'}`}>
                  {preview} {meetsThreshold ? '✓ passes' : '✗ below threshold'}
                </span>
              </div>
            </div>

            <button
              onClick={handleGrantApproval}
              disabled={!hasData && submitStatus !== 'done'}
              className="w-full border border-brand-600 hover:bg-brand-900 disabled:opacity-40 text-brand-400 font-semibold py-3 rounded-xl transition-colors"
            >
              Grant Encrypted Approval
            </button>

            {grantStatus && <p className="text-sm text-brand-300">{grantStatus}</p>}
          </div>

          {/* Loan panel */}
          <div className="bg-white/5 border border-white/10 rounded-2xl p-6 space-y-4">
            <h2 className="font-semibold text-lg">
              {activeLoan?.active ? 'Active Loan' : 'Request a Loan'}
            </h2>

            {activeLoan?.active ? (
              <div className="space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-white/50">Principal</span>
                  <span className="font-mono">{formatEther(activeLoan.principal)} ETH</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-white/50">Collateral locked</span>
                  <span className="font-mono">{formatEther(activeLoan.collateral)} ETH</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-white/50">Credit approved</span>
                  <span className={activeLoan.creditApproved ? 'text-green-400' : 'text-white/50'}>
                    {activeLoan.creditApproved ? 'Yes (110 %)' : 'No (150 %)'}
                  </span>
                </div>
                <button
                  onClick={() => repayLoan(formatEther(activeLoan.principal))}
                  className="w-full bg-red-700 hover:bg-red-600 text-white font-semibold py-3 rounded-xl transition-colors"
                >
                  Repay {formatEther(activeLoan.principal)} ETH
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <label className="text-sm text-white/60 block mb-1">Loan amount (ETH)</label>
                  <input
                    type="number" step="0.01" min="0"
                    value={loanEth}
                    onChange={e => setLoanEth(e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
                  />
                </div>

                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox" checked={useCredit}
                    onChange={e => setUseCredit(e.target.checked)}
                    className="rounded accent-brand-500"
                  />
                  <span className="text-sm text-white/70">
                    Use credit approval{' '}
                    <span className="text-brand-400">(110 % collateral)</span>
                  </span>
                </label>

                <div className="bg-white/5 rounded-lg px-4 py-2 text-sm flex justify-between">
                  <span className="text-white/50">Collateral needed</span>
                  <span className="font-mono">
                    {(parseFloat(loanEth || '0') * (useCredit ? creditRatio : standardRatio) / 100).toFixed(4)} ETH
                  </span>
                </div>

                <button
                  onClick={handleRequestLoan}
                  disabled={useCredit && !hasData}
                  className="w-full bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white font-semibold py-3 rounded-xl transition-colors"
                >
                  Request Loan
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

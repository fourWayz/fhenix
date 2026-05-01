'use client'

import { useState } from 'react'
import { useAccount, useChainId } from 'wagmi'
import { formatEther, parseEther } from 'viem'
import { useCreditScore, type CreditInputs } from '@/hooks/useCreditScore'
import { useLendingPool } from '@/hooks/useLendingPool'
import { useAutoSignals } from '@/hooks/useAutoSignals'
import { useCreditNFT, TIER_LABELS, TIER_COLORS, TIER_BG } from '@/hooks/useCreditNFT'
import { CONTRACT_ADDRESSES, MIN_CREDIT_THRESHOLD } from '@/config'

const EMPTY_INPUTS: CreditInputs = { balance: 0, txFreq: 0, repayment: 0, debtRatio: 0 }

function bpsToPercent(bps: number) {
  return (bps / 100).toFixed(2)
}

function ScoreBar({ score, max = 10000 }: { score: number; max?: number }) {
  const pct   = Math.round((score / max) * 100)
  const color = pct >= 70 ? 'bg-green-500' : pct >= 50 ? 'bg-yellow-500' : 'bg-red-500'
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-sm">
        <span className="text-white/60">Credit score preview</span>
        <span className="font-mono font-bold">{score} / {max}</span>
      </div>
      <div className="h-2 bg-white/10 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between text-xs text-white/30">
        <span>0</span>
        <span>Threshold: {MIN_CREDIT_THRESHOLD}</span>
        <span>{max}</span>
      </div>
    </div>
  )
}

function SignalRow({ label, value, hint }: { label: string; value: number; hint: string }) {
  const pct = value
  const color = pct >= 70 ? 'text-green-400' : pct >= 40 ? 'text-yellow-400' : 'text-red-400'
  return (
    <div className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
      <div>
        <p className="text-sm text-white/80">{label}</p>
        <p className="text-xs text-white/30">{hint}</p>
      </div>
      <div className="flex items-center gap-3 shrink-0 ml-4">
        <div className="w-24 h-1.5 bg-white/10 rounded-full overflow-hidden">
          <div className="h-full bg-current rounded-full transition-all duration-500" style={{ width: `${pct}%`, color: 'inherit' }} />
        </div>
        <span className={`font-mono font-semibold w-8 text-right text-sm ${color}`}>{value}</span>
      </div>
    </div>
  )
}

export default function BorrowerPage() {
  const { isConnected } = useAccount()
  const chainId          = useChainId()
  const addresses        = CONTRACT_ADDRESSES[chainId]

  const {
    hasData, updatedAt,
    rateRevealed, revealedRate,
    submitStatus, submitError,
    rateStatus, rateError,
    submitCreditData,
    grantLenderApproval, allowApprovalPublic,
    computeAndRevealRate,
    resetRateStatus,
    previewScore, previewRate,
  } = useCreditScore()

  const {
    activeLoan, accruedInterest, repaymentDue,
    standardRatio, creditRatio,
    requestLoan, repayLoan,
  } = useLendingPool()

  const { fetchSignals, loading: autoLoading, error: autoError, meta, source } = useAutoSignals()
  const { isDeployed: nftDeployed, hasMinted, tier, totalMinted, mintOrUpdate } = useCreditNFT()

  const [inputs,      setInputs]      = useState<CreditInputs>(EMPTY_INPUTS)
  const [fetched,     setFetched]     = useState(false)
  const [nftStatus,   setNftStatus]   = useState('')
  const [nftError,    setNftError]    = useState('')
  const [loanEth,     setLoanEth]     = useState('0.1')
  const [useCredit,   setUseCredit]   = useState(false)
  const [grantStatus, setGrantStatus] = useState('')
  const [loanStatus,   setLoanStatus]  = useState<'idle' | 'pending' | 'done' | 'error'>('idle')
  const [loanError,    setLoanError]   = useState('')
  const [repayPending, setRepayPending] = useState(false)
  const [repayError,   setRepayError]   = useState('')

  const preview        = previewScore(inputs)
  const estimatedRate  = previewRate(inputs)
  const meetsThreshold = preview >= MIN_CREDIT_THRESHOLD

  async function handleAutoFetch() {
    const result = await fetchSignals()
    if (result) {
      setInputs(result)
      setFetched(true)
    }
  }

  async function handleMintNFT() {
    setNftStatus('Minting…')
    setNftError('')
    try {
      await mintOrUpdate()
      setNftStatus(hasMinted ? 'Tier updated!' : 'NFT minted!')
    } catch (e) {
      setNftError(e instanceof Error ? e.message : String(e))
      setNftStatus('')
    }
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
    setLoanStatus('pending')
    setLoanError('')
    try {
      await requestLoan(loanEth, useCredit)
      setLoanStatus('done')
    } catch (e) {
      setLoanError(e instanceof Error ? e.message : String(e))
      setLoanStatus('error')
    }
  }

  const canRequestCreditLoan = (hasData || submitStatus === 'done') && !!rateRevealed

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

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Borrower Dashboard</h1>
        <p className="text-white/50 mt-1">
          Submit verified on-chain financial signals to compute your private credit score.
        </p>
      </div>

      {/* ── Credit Tier NFT banner ── */}
      {nftDeployed && (
        <div className={`border rounded-2xl p-5 ${TIER_BG[tier]}`}>
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-4">
              <div className={`w-14 h-14 rounded-full border-2 flex items-center justify-center font-bold text-xs tracking-widest ${TIER_COLORS[tier]} border-current`}>
                {TIER_LABELS[tier].toUpperCase()}
              </div>
              <div>
                <div className="font-semibold text-base">
                  {hasMinted
                    ? <span>Credit Tier NFT — <span className={TIER_COLORS[tier]}>{TIER_LABELS[tier]}</span></span>
                    : 'Credit Tier NFT — not minted'}
                </div>
                <p className="text-sm text-white/40 mt-0.5">
                  Soul-bound · on-chain SVG · {totalMinted?.toString() ?? '—'} total minted
                </p>
              </div>
            </div>
            <div className="flex flex-col items-end gap-2">
              <button
                onClick={handleMintNFT}
                disabled={!rateRevealed || Number(revealedRate ?? 1500) >= 1500 || nftStatus === 'Minting…'}
                className="bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition-colors"
              >
                {nftStatus === 'Minting…' ? 'Minting…' : hasMinted ? 'Update Tier' : 'Mint Tier NFT'}
              </button>
              {!rateRevealed && (
                <p className="text-xs text-white/30">Complete Step 2 to reveal your rate</p>
              )}
              {rateRevealed && Number(revealedRate ?? 1500) >= 1500 && (
                <p className="text-xs text-yellow-400">Rate is at base (15%) — score must exceed 7 000</p>
              )}
              {nftStatus && nftStatus !== 'Minting…' && <p className="text-xs text-green-400">{nftStatus}</p>}
              {nftError && <p className="text-xs text-red-400">{nftError}</p>}
            </div>
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-6">
        {/* ── Left: verified credit signals ── */}
        <div className="bg-white/5 border border-white/10 rounded-2xl p-6 space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-lg">Credit Signals</h2>
              <p className="text-xs text-white/30 mt-0.5">Read from your wallet — not self-reported</p>
            </div>
            <span className="text-xs text-white/30 bg-white/5 rounded-full px-3 py-1">Encrypted client-side</span>
          </div>

          {/* Auto-fetch panel */}
          <div className="bg-brand-950/60 border border-brand-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-brand-300">Fetch from your wallet</p>
                <p className="text-xs text-white/40 mt-0.5">Reads balance, tx count &amp; repayment history on-chain</p>
              </div>
              <button
                onClick={handleAutoFetch}
                disabled={autoLoading}
                className="bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white text-xs font-semibold px-4 py-2 rounded-lg transition-colors whitespace-nowrap"
              >
                {autoLoading ? 'Reading chain…' : fetched ? 'Refresh' : 'Fetch signals'}
              </button>
            </div>

            {meta && source === 'chain' && (
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-white/5 rounded-lg px-3 py-1.5 text-xs">
                  <span className="text-white/40">Balance</span>
                  <span className="font-mono text-white ml-2">{meta.balanceEth.toFixed(4)} ETH</span>
                </div>
                <div className="bg-white/5 rounded-lg px-3 py-1.5 text-xs">
                  <span className="text-white/40">Txs</span>
                  <span className="font-mono text-white ml-2">{meta.txCount}</span>
                </div>
                <div className="bg-white/5 rounded-lg px-3 py-1.5 text-xs">
                  <span className="text-white/40">Repayments</span>
                  <span className="font-mono text-white ml-2">{meta.repayments}</span>
                </div>
                <div className="bg-white/5 rounded-lg px-3 py-1.5 text-xs">
                  <span className="text-white/40">Active loan</span>
                  <span className={`font-mono ml-2 ${meta.hasActiveLoan ? 'text-yellow-400' : 'text-green-400'}`}>
                    {meta.hasActiveLoan ? 'Yes' : 'None'}
                  </span>
                </div>
              </div>
            )}
            {autoError && <p className="text-red-400 text-xs">{autoError}</p>}

            {!fetched && (
              <p className="text-xs text-white/30 text-center">
                Fetch your wallet data above to populate your credit signals.
              </p>
            )}
          </div>

          {/* Signal display — read-only */}
          <div className="space-y-0">
            <SignalRow label="Wallet Balance Score"  hint="Portfolio size relative to network median"       value={inputs.balance}   />
            <SignalRow label="Transaction Frequency" hint="On-chain transaction count over account lifetime" value={inputs.txFreq}    />
            <SignalRow label="Repayment History"     hint="Successful CipherCredit loan repayments"         value={inputs.repayment} />
            <SignalRow label="Existing Debt Ratio"   hint="Current debt burden — lower is better"           value={inputs.debtRatio} />
          </div>

          {/* Score + rate preview */}
          <div className="space-y-3 pt-1">
            <ScoreBar score={preview} />
            <div className="flex items-center justify-between bg-white/5 rounded-xl px-4 py-3">
              <span className="text-sm text-white/50">Estimated APR (credit tier)</span>
              <span className={`font-mono font-bold text-lg ${meetsThreshold ? 'text-green-400' : 'text-white/30'}`}>
                {meetsThreshold ? `${bpsToPercent(estimatedRate)} %` : 'N/A'}
              </span>
            </div>
            <p className="text-xs text-white/30">Preview only — actual rate computed in FHE on-chain.</p>
          </div>

          <button
            onClick={() => submitCreditData(inputs)}
            disabled={!fetched || submitStatus === 'encrypting' || submitStatus === 'submitting'}
            className="w-full bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white font-semibold py-3 rounded-xl transition-colors"
          >
            {submitStatus === 'encrypting' ? 'Encrypting…' :
             submitStatus === 'submitting' ? 'Submitting…' :
             submitStatus === 'done'       ? 'Re-submit'   :
             !fetched                      ? 'Fetch signals first' :
             'Encrypt & Submit'}
          </button>

          {submitError && <p className="text-red-400 text-sm">{submitError}</p>}
          {hasData && updatedAt && (
            <p className="text-green-400 text-sm text-center">
              Credit data on-chain since {new Date(Number(updatedAt) * 1000).toLocaleDateString()}
            </p>
          )}
        </div>

        {/* ── Right column ── */}
        <div className="space-y-4">

          {/* Step 1 — Grant approval */}
          <div className="bg-white/5 border border-white/10 rounded-2xl p-6 space-y-4">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold bg-brand-700 rounded-full px-2 py-0.5">Step 1</span>
              <h2 className="font-semibold">Grant Pool Access</h2>
            </div>
            <p className="text-sm text-white/50">
              Issue the pool an encrypted pass/fail verdict. It sees <strong className="text-white">only true or false</strong> — never your score.
            </p>

            <div className="bg-white/5 rounded-xl p-4 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-white/50">Pool</span>
                <span className="font-mono text-xs text-white/70">{addresses.pool?.slice(0, 10)}…</span>
              </div>
              <div className="flex justify-between">
                <span className="text-white/50">Threshold</span>
                <span className="font-mono">{MIN_CREDIT_THRESHOLD} / 10 000</span>
              </div>
              <div className="flex justify-between">
                <span className="text-white/50">Preview</span>
                <span className={`font-mono ${meetsThreshold ? 'text-green-400' : 'text-red-400'}`}>
                  {preview} {meetsThreshold ? '✓ passes' : '✗ below threshold'}
                </span>
              </div>
            </div>

            <button
              onClick={handleGrantApproval}
              disabled={(!hasData && submitStatus !== 'done') || rateStatus === 'computing' || rateStatus === 'revealing'}
              className="w-full border border-brand-600 hover:bg-brand-900 disabled:opacity-40 text-brand-400 font-semibold py-3 rounded-xl transition-colors"
            >
              Grant Encrypted Approval
            </button>
            {grantStatus && <p className="text-sm text-brand-300">{grantStatus}</p>}
          </div>

          {/* Step 2 — Compute & reveal rate */}
          <div className="bg-white/5 border border-white/10 rounded-2xl p-6 space-y-4">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold bg-brand-700 rounded-full px-2 py-0.5">Step 2</span>
              <h2 className="font-semibold">Get Your Personal Rate</h2>
            </div>
            <p className="text-sm text-white/50">
              FHE computes your exact APR from the encrypted score — the pool never sees your data, only the derived rate.
            </p>

            {/* Rate display */}
            {rateRevealed && revealedRate != null ? (
              <div className="bg-brand-900/50 border border-brand-700 rounded-xl p-4 text-center">
                <div className="text-xs text-brand-400 uppercase tracking-wider mb-1">Your personal APR</div>
                <div className="text-4xl font-bold text-brand-300">{bpsToPercent(Number(revealedRate))} %</div>
                <div className="text-xs text-white/30 mt-1">
                  vs. {bpsToPercent(1500)} % standard — computed privately in FHE
                </div>
              </div>
            ) : (
              <div className="bg-white/5 rounded-xl p-4 text-center text-white/30 text-sm">
                {!fetched
                  ? 'Fetch your wallet data first'
                  : meetsThreshold
                  ? `Estimated ${bpsToPercent(estimatedRate)} % — click below to lock in your rate`
                  : 'Score below threshold — improve on-chain activity first'}
              </div>
            )}

            {/* Status indicator during computation */}
            {(rateStatus === 'computing' || rateStatus === 'revealing') && (
              <div className="flex items-center gap-2 text-sm text-brand-300">
                <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
                {rateStatus === 'computing' ? 'Computing rate in FHE (tx 1/2)…' : 'Recording rate on-chain (tx 2/2)…'}
              </div>
            )}

            <button
              onClick={() => computeAndRevealRate(estimatedRate)}
              disabled={
                (!hasData && submitStatus !== 'done') ||
                (!meetsThreshold && !rateRevealed) ||
                rateStatus === 'computing' ||
                rateStatus === 'revealing'
              }
              className="w-full border border-brand-600 hover:bg-brand-900 disabled:opacity-40 text-brand-400 font-semibold py-3 rounded-xl transition-colors"
            >
              {rateStatus === 'computing' || rateStatus === 'revealing'
                ? 'Processing…'
                : rateRevealed
                ? 'Recompute Rate'
                : 'Compute & Reveal Rate'}
            </button>

            {rateError && (
              <div className="space-y-1">
                <p className="text-red-400 text-sm">{rateError}</p>
                <button onClick={resetRateStatus} className="text-xs text-white/40 hover:text-white/70 underline">
                  Reset
                </button>
              </div>
            )}
          </div>

          {/* Step 3 — Loan panel */}
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
                  <span className="text-white/50">APR</span>
                  <span className={`font-mono ${activeLoan.creditApproved ? 'text-green-400' : 'text-white/70'}`}>
                    {bpsToPercent(activeLoan.interestRateBps)} %
                    {activeLoan.creditApproved ? ' (credit tier)' : ' (standard)'}
                  </span>
                </div>
                {accruedInterest != null && (
                  <div className="flex justify-between text-sm">
                    <span className="text-white/50">Accrued interest</span>
                    <span className="font-mono text-yellow-400">
                      {parseFloat(formatEther(accruedInterest)).toFixed(8)} ETH
                    </span>
                  </div>
                )}
                {repaymentDue != null && (
                  <div className="flex justify-between text-sm font-semibold border-t border-white/10 pt-2">
                    <span className="text-white/70">Total due now</span>
                    <span className="font-mono">{parseFloat(formatEther(repaymentDue)).toFixed(6)} ETH</span>
                  </div>
                )}
                <button
                  onClick={async () => {
                    setRepayPending(true)
                    setRepayError('')
                    try { await repayLoan() }
                    catch (e) { setRepayError(e instanceof Error ? e.message : String(e)) }
                    finally { setRepayPending(false) }
                  }}
                  disabled={repaymentDue == null || repayPending}
                  className="w-full bg-red-700 hover:bg-red-600 disabled:opacity-40 text-white font-semibold py-3 rounded-xl transition-colors"
                >
                  {repayPending ? 'Repaying…' : 'Repay Loan (principal + interest)'}
                </button>
                {repayError && <p className="text-red-400 text-sm">{repayError}</p>}
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
                    Use credit tier{' '}
                    <span className="text-brand-400">
                      (110 % collateral
                      {rateRevealed && revealedRate != null ? `, ${bpsToPercent(Number(revealedRate))} % APR` : ', personal APR'}
                      )
                    </span>
                  </span>
                </label>

                <div className="bg-white/5 rounded-lg px-4 py-2 text-sm space-y-1">
                  <div className="flex justify-between">
                    <span className="text-white/50">Collateral needed</span>
                    <span className="font-mono">
                      {(() => {
                        try {
                          const p = parseEther(loanEth || '0')
                          const r = BigInt(useCredit ? creditRatio : standardRatio)
                          return formatEther((p * r) / BigInt(100))
                        } catch { return '—' }
                      })()} ETH
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-white/50">APR</span>
                    <span className="font-mono">
                      {useCredit && rateRevealed && revealedRate != null
                        ? `${bpsToPercent(Number(revealedRate))} %`
                        : useCredit ? 'Reveal rate first' : '15.00 %'}
                    </span>
                  </div>
                </div>

                {useCredit && !rateRevealed && (
                  <p className="text-xs text-yellow-400">Complete Step 2 above to unlock your personal rate.</p>
                )}

                <button
                  onClick={handleRequestLoan}
                  disabled={(useCredit && !canRequestCreditLoan) || loanStatus === 'pending'}
                  className="w-full bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white font-semibold py-3 rounded-xl transition-colors"
                >
                  {loanStatus === 'pending' ? 'Requesting loan…' : 'Request Loan'}
                </button>
                {loanError && <p className="text-red-400 text-sm">{loanError}</p>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

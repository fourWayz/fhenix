import { useCallback } from 'react'
import { useAccount, useChainId, usePublicClient, useReadContract, useWriteContract } from 'wagmi'
import { parseEther } from 'viem'
import { LendingPoolABI } from '@/abis/LendingPool'
import { CONTRACT_ADDRESSES } from '@/config'

function poolAddress(chainId: number) {
  return CONTRACT_ADDRESSES[chainId]?.pool
}

export function useLendingPool() {
  const { address } = useAccount()
  const chainId     = useChainId()
  const addr        = poolAddress(chainId)

  const { writeContractAsync } = useWriteContract()
  const publicClient = usePublicClient()

  // ── Pool stats ──────────────────────────────────────────────────────────────

  const { data: liquidity,   refetch: refetchLiquidity } = useReadContract({
    address: addr,
    abi:     LendingPoolABI,
    functionName: 'availableLiquidity',
    query:   { enabled: !!addr },
  })

  const { data: totalBorrowed  } = useReadContract({
    address: addr,
    abi:     LendingPoolABI,
    functionName: 'totalBorrowed',
    query:   { enabled: !!addr },
  })

  const { data: totalDeposited } = useReadContract({
    address: addr,
    abi:     LendingPoolABI,
    functionName: 'totalDeposited',
    query:   { enabled: !!addr },
  })

  // ── Current user's loan ─────────────────────────────────────────────────────

  const { data: activeLoanRaw, refetch: refetchLoan } = useReadContract({
    address: addr,
    abi:     LendingPoolABI,
    functionName: 'loans',
    args:    address ? [address] : undefined,
    query:   { enabled: !!address && !!addr },
  })

  const activeLoan = activeLoanRaw
    ? {
        principal:       activeLoanRaw[0] as bigint,
        collateral:      activeLoanRaw[1] as bigint,
        creditApproved:  activeLoanRaw[2] as boolean,
        active:          activeLoanRaw[3] as boolean,
        issuedAt:        activeLoanRaw[4] as bigint,
        interestRateBps: activeLoanRaw[5] as number,
      }
    : null

  // Live accrued interest for the active loan
  const { data: accruedInterest } = useReadContract({
    address: addr,
    abi:     LendingPoolABI,
    functionName: 'getAccruedInterest',
    args:    address ? [address] : undefined,
    query:   { enabled: !!address && !!addr && !!activeLoan?.active, refetchInterval: 15_000 },
  })

  // Total repayment due (principal + interest)
  const { data: repaymentDue } = useReadContract({
    address: addr,
    abi:     LendingPoolABI,
    functionName: 'totalRepaymentDue',
    args:    address ? [address] : undefined,
    query:   { enabled: !!address && !!addr && !!activeLoan?.active, refetchInterval: 15_000 },
  })

  const { data: myDeposit } = useReadContract({
    address: addr,
    abi:     LendingPoolABI,
    functionName: 'providerDeposits',
    args:    address ? [address] : undefined,
    query:   { enabled: !!address && !!addr },
  })

  // ── Collateral ratio constants ──────────────────────────────────────────────

  const { data: stdCollateral   } = useReadContract({ address: addr, abi: LendingPoolABI, functionName: 'STANDARD_RATIO', query: { enabled: !!addr } })
  const { data: creditCollateral} = useReadContract({ address: addr, abi: LendingPoolABI, functionName: 'CREDIT_RATIO',   query: { enabled: !!addr } })

  // ── Gas helper ───────────────────────────────────────────────────────────────

  const gasFees = useCallback(async () => {
    if (!publicClient) return {}
    const fees = await publicClient.estimateFeesPerGas()
    const fee = fees.maxFeePerGas ?? 0n
    // Priority fee is null on many L2s; use 10% of maxFeePerGas so MetaMask
    // doesn't reject the tx as "unavailable fee" due to a zero tip.
    const tip = (fees.maxPriorityFeePerGas != null && fees.maxPriorityFeePerGas > 0n)
      ? fees.maxPriorityFeePerGas
      : fee > 0n ? fee / 10n : 1_000_000n
    return {
      ...(fee > 0n ? { maxFeePerGas: fee } : {}),
      maxPriorityFeePerGas: tip,
    }
  }, [publicClient])

  // ── Actions ─────────────────────────────────────────────────────────────────

  const deposit = useCallback(async (amountEth: string) => {
    if (!addr) throw new Error('Pool not deployed on this chain')
    const hash = await writeContractAsync({
      address: addr,
      abi:     LendingPoolABI,
      functionName: 'deposit',
      value:   parseEther(amountEth),
      ...(await gasFees()),
    })
    await refetchLiquidity()
    return hash
  }, [addr, writeContractAsync, gasFees, refetchLiquidity])

  const withdraw = useCallback(async (amountEth: string) => {
    if (!addr) throw new Error('Pool not deployed on this chain')
    return writeContractAsync({
      address: addr,
      abi:     LendingPoolABI,
      functionName: 'withdraw',
      args: [parseEther(amountEth)],
      ...(await gasFees()),
    })
  }, [addr, writeContractAsync, gasFees])

  const requestLoan = useCallback(async (
    principalEth: string,
    useCredit: boolean,
  ) => {
    if (!addr || !address) throw new Error('Pool not deployed on this chain')
    const principal = parseEther(principalEth)
    // Replicate the contract's integer formula to avoid float truncation errors.
    // toFixed(4) on 0.0003*1.5=0.00045 gives "0.0004", which is less than required.
    const ratio      = useCredit
      ? (creditCollateral != null ? BigInt(creditCollateral as bigint) : 110n)
      : (stdCollateral    != null ? BigInt(stdCollateral as bigint)    : 150n)
    const collateral = (principal * ratio) / 100n

    // Dry-run to catch contract logic reverts before opening MetaMask.
    // Skip balance/gas errors — those are overly conservative in simulation.
    try {
      await publicClient!.simulateContract({
        address: addr,
        abi:     LendingPoolABI,
        functionName: 'requestLoan',
        args:    [principal, useCredit],
        value:   collateral,
        account: address,
      })
    } catch (e: any) {
      const msg: string = e?.message ?? String(e)
      const isBalanceOrGasError =
        msg.includes('exceeds the balance') ||
        msg.includes('insufficient funds') ||
        msg.includes('InsufficientFunds') ||
        e?.name === 'InsufficientFundsError'
      if (!isBalanceOrGasError) {
        throw new Error(e?.cause?.reason ?? e?.shortMessage ?? msg)
      }
    }

    const hash = await writeContractAsync({
      address: addr,
      abi:     LendingPoolABI,
      functionName: 'requestLoan',
      args:    [principal, useCredit],
      value:   collateral,
      ...(await gasFees()),
    })
    if (publicClient) await publicClient.waitForTransactionReceipt({ hash })
    await refetchLoan()
    return hash
  }, [addr, address, stdCollateral, creditCollateral, writeContractAsync, gasFees, publicClient, refetchLoan])

  const repayLoan = useCallback(async () => {
    if (!addr || repaymentDue == null) throw new Error('Pool not deployed or no active loan')
    const withBuffer = (repaymentDue * 101n) / 100n
    const hash = await writeContractAsync({
      address: addr,
      abi:     LendingPoolABI,
      functionName: 'repayLoan',
      value:   withBuffer,
      ...(await gasFees()),
    })
    if (publicClient) await publicClient.waitForTransactionReceipt({ hash })
    await refetchLoan()
    return hash
  }, [addr, repaymentDue, writeContractAsync, gasFees, publicClient, refetchLoan])

  return {
    addr,
    liquidity,
    totalBorrowed,
    totalDeposited,
    activeLoan,
    accruedInterest,
    repaymentDue,
    myDeposit,
    standardRatio: stdCollateral    ? Number(stdCollateral)    : 150,
    creditRatio:   creditCollateral ? Number(creditCollateral) : 110,
    deposit,
    withdraw,
    requestLoan,
    repayLoan,
  }
}

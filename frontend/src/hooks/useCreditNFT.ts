import { useCallback } from 'react'
import { useAccount, useChainId, usePublicClient, useReadContract, useWriteContract } from 'wagmi'
import { CreditTierNFTABI } from '@/abis/CreditTierNFT'
import { CONTRACT_ADDRESSES } from '@/config'

// Matches CreditTierNFT.Tier enum: 0=None 1=Bronze 2=Silver 3=Gold
export type TierValue = 0 | 1 | 2 | 3

export const TIER_LABELS: Record<TierValue, string> = {
  0: 'None',
  1: 'Bronze',
  2: 'Silver',
  3: 'Gold',
}

export const TIER_COLORS: Record<TierValue, string> = {
  0: 'text-white/30',
  1: 'text-amber-700',
  2: 'text-slate-300',
  3: 'text-amber-400',
}

export const TIER_BG: Record<TierValue, string> = {
  0: 'bg-white/5 border-white/10',
  1: 'bg-amber-950/30 border-amber-800/40',
  2: 'bg-slate-900/40 border-slate-600/40',
  3: 'bg-amber-950/30 border-amber-500/40',
}

function nftAddress(chainId: number) {
  return CONTRACT_ADDRESSES[chainId]?.nft
}

export function useCreditNFT() {
  const { address } = useAccount()
  const chainId     = useChainId()
  const addr        = nftAddress(chainId)

  const { writeContractAsync }  = useWriteContract()
  const publicClient            = usePublicClient()

  const isDeployed = addr && addr !== '0x0000000000000000000000000000000000000000'

  const { data: hasMinted, refetch: refetchMinted } = useReadContract({
    address:      addr,
    abi:          CreditTierNFTABI,
    functionName: 'hasMinted',
    args:         address ? [address] : undefined,
    query:        { enabled: !!isDeployed && !!address },
  })

  const { data: tierRaw, refetch: refetchTier } = useReadContract({
    address:      addr,
    abi:          CreditTierNFTABI,
    functionName: 'tiers',
    args:         address ? [address] : undefined,
    query:        { enabled: !!isDeployed && !!address },
  })

  const { data: totalMinted } = useReadContract({
    address:      addr,
    abi:          CreditTierNFTABI,
    functionName: 'totalMinted',
    query:        { enabled: !!isDeployed },
  })

  const tier = (typeof tierRaw === 'number' ? tierRaw : Number(tierRaw ?? 0)) as TierValue

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

  const mintOrUpdate = useCallback(async () => {
    if (!addr || !isDeployed) throw new Error('NFT not deployed on this chain')
    const hash = await writeContractAsync({
      address:      addr,
      abi:          CreditTierNFTABI,
      functionName: 'mintOrUpdateTier',
      ...(await gasFees()),
    })
    if (publicClient) await publicClient.waitForTransactionReceipt({ hash })
    await Promise.all([refetchMinted(), refetchTier()])
    return hash
  }, [addr, isDeployed, writeContractAsync, gasFees, publicClient, refetchMinted, refetchTier])

  return {
    isDeployed,
    hasMinted,
    tier,
    totalMinted,
    mintOrUpdate,
  }
}

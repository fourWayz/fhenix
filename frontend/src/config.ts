import { arbitrumSepolia, baseSepolia } from 'wagmi/chains'

type Addresses = { registry: `0x${string}`; pool: `0x${string}`; nft: `0x${string}` }

export const CONTRACT_ADDRESSES: Record<number, Addresses> = {
  // Arbitrum Sepolia (chainId 421614)
  [arbitrumSepolia.id]: {
    registry: '0x6C0E2b4C44ed9F3ED057a2fdF1dE4c53Ec997567',
    pool:     '0xa646663c7D269363c62198EFb1d69Fc1d24e298B',
    nft:      '0x7b5353c1c76f0fBdF40000DF272Ee81A3e9b7C9F',
  },
  // Base Sepolia (chainId 84532)
  [baseSepolia.id]: {
    registry: '0x0000000000000000000000000000000000000000',
    pool:     '0x0000000000000000000000000000000000000000',
    nft:      '0x0000000000000000000000000000000000000000',
  },
}

export const SUPPORTED_CHAINS = [arbitrumSepolia, baseSepolia] as const

export const MIN_CREDIT_THRESHOLD = 7_000
export const BASE_RATE_BPS        = 1_500   // 15.00%
export const MIN_RATE_BPS         =   800   // 8.00%

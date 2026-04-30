import { arbitrumSepolia, baseSepolia } from 'wagmi/chains'

type Addresses = { registry: `0x${string}`; pool: `0x${string}`; nft: `0x${string}` }

export const CONTRACT_ADDRESSES: Record<number, Addresses> = {
  // Arbitrum Sepolia (chainId 421614)
  [arbitrumSepolia.id]: {
    registry: '0xDe6615E28a8F413Dd2728a3A0156bF7efF2A974C',
    pool:     '0x099f850Cbb05b45E83DA34ED93855fdF88260991',
    nft:      '0x3Eed4f826CBF1FE513EcC1369CCfd2388A668697', // set after redeploy
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

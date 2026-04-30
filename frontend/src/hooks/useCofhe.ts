import { useCallback, useEffect, useState } from 'react'
import { useAccount, usePublicClient, useWalletClient } from 'wagmi'
import { createCofheConfig, createCofheClient } from '@cofhe/sdk/web'
import { Encryptable, FheTypes } from '@cofhe/sdk'
import type { CofheClient } from '@cofhe/sdk'
import { getChainById } from '@cofhe/sdk/chains'

type Status = 'idle' | 'connecting' | 'ready' | 'error'

export function useCofhe() {
  const { address, chainId } = useAccount()
  const { data: walletClient } = useWalletClient()
  const publicClient = usePublicClient()

  const [client, setClient] = useState<CofheClient | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError]   = useState<string | null>(null)

  useEffect(() => {
    if (!walletClient || !publicClient || !chainId || !address) {
      setClient(null)
      setStatus('idle')
      return
    }

    let cancelled = false

    async function init() {
      setStatus('connecting')
      try {
        const chain = getChainById(chainId!)
        if (!chain) throw new Error(`Chain ${chainId} not supported by CoFHE`)

        const config = createCofheConfig({ supportedChains: [chain] })

        const c = createCofheClient(config)
        await c.connect(publicClient as any, walletClient as any)
        await c.permits.createSelf({ issuer: address! })

        if (!cancelled) {
          setClient(c)
          setStatus('ready')
          setError(null)
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
          setStatus('error')
        }
      }
    }

    init()
    return () => { cancelled = true }
  }, [walletClient, publicClient, chainId, address])

  // Encrypt up to 4 uint32 values and return the InEuint32 structs
  const encryptUint32s = useCallback(
    async (...values: bigint[]) => {
      if (!client) throw new Error('CoFHE client not ready')
      return client.encryptInputs(values.map(v => Encryptable.uint32(v))).execute()
    },
    [client],
  )

  // Decrypt a single euint32 handle (view — requires permit)
  const decryptUint32 = useCallback(
    async (handle: bigint) => {
      if (!client) throw new Error('CoFHE client not ready')
      return client.decryptForView(handle, FheTypes.Uint32).execute()
    },
    [client],
  )

  // Decrypt a handle for a tx — returns plaintext + threshold-network signature
  const decryptForTx = useCallback(
    async (handle: bigint) => {
      if (!client) throw new Error('CoFHE client not ready')
      return client.decryptForTx(handle).withoutPermit().execute()
    },
    [client],
  )

  return { client, status, error, encryptUint32s, decryptUint32, decryptForTx }
}

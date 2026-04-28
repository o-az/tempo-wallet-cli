import type { Address } from 'ox'

export type Network = {
  authUrl: string
  chainId: number
  explorerUrl: string
  name: 'tempo' | 'tempo-moderato'
  rpcUrl: string
  token: {
    address: Address.Address
    decimals: number
    symbol: string
  }
}

export const networks = {
  tempo: {
    authUrl: 'https://wallet.tempo.xyz/cli-auth',
    chainId: 4217,
    explorerUrl: 'https://explore.tempo.xyz',
    name: 'tempo',
    rpcUrl: 'https://rpc.mainnet.tempo.xyz',
    token: {
      address: '0x20c000000000000000000000b9537d11c60e8b50',
      decimals: 6,
      symbol: 'USDC.e'
    }
  },
  'tempo-moderato': {
    authUrl: 'https://wallet.moderato.tempo.xyz/cli-auth',
    chainId: 42431,
    explorerUrl: 'https://explore.moderato.tempo.xyz',
    name: 'tempo-moderato',
    rpcUrl: 'https://rpc.moderato.tempo.xyz',
    token: {
      address: '0x20c0000000000000000000000000000000000000',
      decimals: 6,
      symbol: 'pathUSD'
    }
  }
} as const satisfies Record<string, Network>

export function resolveNetwork(value?: string): Network {
  if (!value) return networks.tempo

  const normalized = value.trim().toLowerCase()
  if (normalized === 'tempo' || normalized === 'mainnet') return networks.tempo
  if (normalized === 'tempo-moderato' || normalized === 'testnet' || normalized === 'moderato')
    return networks['tempo-moderato']

  throw new Error(`Unknown network '${value}'.`)
}

export function networkFromChainId(chainId: number) {
  return Object.values(networks).find(network => network.chainId === chainId)
}

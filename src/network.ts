export type Network = {
  authUrl: string
  chainId: number
  name: 'tempo' | 'tempo-moderato'
  token: {
    address: `0x${string}`
    decimals: number
    symbol: string
  }
}

export const networks = {
  tempo: {
    authUrl: 'https://wallet.tempo.xyz/cli-auth',
    chainId: 4217,
    name: 'tempo',
    token: {
      address: '0x20c000000000000000000000b9537d11c60e8b50',
      decimals: 6,
      symbol: 'USDC.e'
    }
  },
  'tempo-moderato': {
    authUrl: 'https://wallet.moderato.tempo.xyz/cli-auth',
    chainId: 42431,
    name: 'tempo-moderato',
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

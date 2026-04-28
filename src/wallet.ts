import { z } from 'incur'
import type { Address, Hex } from 'ox'
import { KeyAuthorization } from 'ox/tempo'
import { tempo, tempoModerato } from 'viem/chains'
import { Account, Actions, Abis } from 'viem/tempo'
import { createPublicClient, createWalletClient, http, parseUnits } from 'viem'

import {
  hasWallet,
  loadKeystore,
  type KeyEntry,
  keyForNetwork,
  normalizeAddress
} from '#keystore.ts'
import { networkFromChainId, type Network } from '#network.ts'
import { shouldRenderText, type GlobalOptions } from '#output.ts'
import { loadKeychainSecret } from '#key-storage.ts'

type KeyInfo = {
  address: string
  balance?: string | undefined
  chain_id: number
  expires_at?: string | undefined
  key?: string | undefined
  key_storage?: string | undefined
  network: string
  spending_limit?: SpendingLimitInfo | undefined
  symbol?: string | undefined
  token?: string | undefined
  wallet_address?: string | undefined
  wallet_type?: string | undefined
}

type SpendingLimitInfo = {
  limit?: string | undefined
  remaining?: string | undefined
  spent?: string | undefined
  unlimited: boolean
}

type WhoamiResponse = {
  balance?:
    | {
        active_sessions: number
        available: string
        locked: string
        symbol: string
        total: string
      }
    | undefined
  key?: Omit<KeyInfo, 'balance' | 'wallet_address' | 'wallet_type'> | undefined
  ready: boolean
  wallet?: string | undefined
}

export const transferArgs = z.object({
  amount: z.string().describe('Amount in human units ("1.00", "50")'),
  token: z.string().describe('Token contract address (0x...)'),
  to: z.string().describe('Recipient address (0x...)')
})

export const transferOptions = z.object({
  dryRun: z.boolean().optional().describe("Show plan + fee estimate, don't send"),
  feeToken: z.string().optional().describe('Pay fees in a different token (default: same token)')
})

type TransferContext = {
  args: z.infer<typeof transferArgs>
  options: z.infer<typeof transferOptions>
}

export async function whoami(network: Network, globals: GlobalOptions) {
  return await showWhoami(network, globals)
}

export async function keys(network: Network, globals: GlobalOptions) {
  const entries = await loadKeystore()
  const response = {
    keys: await Promise.all(
      entries.map(entry => buildKeyInfo(networkForEntry(network, entry), entry))
    ),
    total: entries.length
  }

  if (shouldRenderText(globals)) {
    if (response.keys.length === 0) {
      process.stdout.write('No keys configured.\n')
      return undefined
    }
    const chunks = response.keys.map((key, index) => {
      const entry = entries[index]!
      const lines: string[] = []
      if (key.wallet_address) lines.push(field('Wallet', key.wallet_address))
      if (key.balance && key.symbol) lines.push(field('Balance', `${key.balance} ${key.symbol}`))
      lines.push(field('Key', entry.key ?? key.address))
      lines.push(field('Chain', key.network))
      const expiry = formatExpiry(entry.expiry)
      if (expiry) lines.push(field('Expires', expiry))
      if (key.spending_limit) lines.push(formatLimit(key))
      return lines.filter(Boolean).join('\n')
    })
    process.stdout.write(`${chunks.join('\n\n')}\n\n${response.keys.length} key(s) total.\n`)
    return undefined
  }

  return response
}

export async function showWhoami(network: Network, globals: GlobalOptions) {
  const entries = await loadKeystore()
  const key = keyForNetwork(entries, network.chainId)
  const response = await buildWhoamiResponse(network, entries, key)

  if (!shouldRenderText(globals)) return response

  if (!key || !response.wallet) {
    process.stdout.write('Not logged in. Run `tempo wallet login` to get started.\n')
    return undefined
  }

  const lines = [field('Wallet', response.wallet)]
  if (response.balance) {
    lines.push(field('Balance', `${response.balance.total} ${response.balance.symbol}`))
    if (response.balance.active_sessions > 0) {
      const label = response.balance.active_sessions === 1 ? 'session' : 'sessions'
      lines.push(
        field(
          'Locked',
          `${response.balance.locked} ${response.balance.symbol} (${response.balance.active_sessions} active ${label})`
        )
      )
      lines.push(field('Available', `${response.balance.available} ${response.balance.symbol}`))
    }
  }
  if (response.key) {
    lines.push('')
    lines.push(field('Key', response.key.address))
    lines.push(field('Chain', network.name))
    const expiry = formatExpiry(key.expiry)
    if (expiry) lines.push(field('Expires', expiry))
    if (response.key.spending_limit) lines.push(formatLimit(response.key))
  }
  process.stdout.write(`${lines.join('\n')}\n`)
  return undefined
}

export async function transfer(network: Network, globals: GlobalOptions, c: TransferContext) {
  const entries = await loadKeystore()
  const entry = requireNetworkKey(entries, network)
  const to = normalizeAddress(c.args.to)
  const token = await resolveToken(network, c.args.token)
  const amount = resolveAmount(c.args.amount, token)
  const feeToken = c.options.feeToken ? normalizeAddress(c.options.feeToken) : token.address
  const from = normalizeAddress(entry.walletAddress)

  if (c.options.dryRun) {
    const response = transferResponse({
      amount: c.args.amount,
      chainId: network.chainId,
      from,
      status: 'dry_run',
      symbol: token.symbol,
      to,
      token: token.address
    })
    if (!shouldRenderText(globals)) return response
    process.stderr.write(
      [
        '[DRY RUN]\n',
        `  Sending ${c.args.amount} ${token.symbol} -> ${shortAddress(to)}\n`,
        `  From: ${shortAddress(from)}\n`,
        `  Fee token: ${feeToken}\n`
      ].join('')
    )
    return undefined
  }

  if (shouldRenderText(globals))
    process.stderr.write(`  Sending ${c.args.amount} ${token.symbol} -> ${shortAddress(to)}\n`)

  const client = createWalletClient({
    account: await accountForEntry(entry),
    chain: chainForNetwork(network),
    transport: http(network.rpcUrl)
  })
  const keyAuthorization = parseStoredKeyAuthorization(entry)

  const txHash = await withProvisioningRetry(
    () =>
      Actions.token.transfer(client, {
        amount,
        feeToken,
        to,
        token: token.address
      }),
    () =>
      Actions.token.transfer(client, {
        amount,
        feeToken,
        keyAuthorization,
        to,
        token: token.address
      }),
    keyAuthorization
  )

  const response = transferResponse({
    amount: c.args.amount,
    chainId: network.chainId,
    from,
    status: 'success',
    symbol: token.symbol,
    to,
    token: token.address,
    txHash
  })

  if (!shouldRenderText(globals)) return response
  process.stderr.write(`\n  Submitted\n    TX: ${txHash}\n    ${txUrl(network, txHash)}\n`)
  return undefined
}

async function buildWhoamiResponse(
  network: Network,
  entries: readonly KeyEntry[],
  key: KeyEntry | undefined
): Promise<WhoamiResponse> {
  if (!key) return { ready: false }

  const keyInfo = await buildKeyInfo(network, key)
  const balance = keyInfo.balance
    ? {
        active_sessions: 0,
        available: keyInfo.balance,
        locked: '0',
        symbol: keyInfo.symbol ?? network.token.symbol,
        total: keyInfo.balance
      }
    : undefined

  const {
    balance: _balance,
    wallet_address: _walletAddress,
    wallet_type: _walletType,
    ...responseKey
  } = keyInfo

  return {
    ready:
      hasWallet(entries) &&
      Boolean(
        keyInfo.address !== 'none' &&
        (key.key || key.keyReference || key.keyAuthorization || key.keyStorage === 'secure-enclave')
      ),
    wallet: normalizeAddress(key.walletAddress),
    ...(balance ? { balance } : {}),
    key: responseKey
  }
}

async function buildKeyInfo(network: Network, entry: KeyEntry): Promise<KeyInfo> {
  const token = entry.limits[0]?.currency ?? network.token.address
  const tokenInfo = await resolveToken(network, token).catch(() => ({
    address: token,
    decimals: network.token.decimals,
    symbol: network.token.symbol
  }))
  const balance = await queryBalance(
    network,
    normalizeAddress(entry.walletAddress),
    tokenInfo
  ).catch(() => undefined)

  return {
    address: entry.keyAddress ? normalizeAddress(entry.keyAddress) : 'none',
    ...(balance ? { balance } : {}),
    chain_id: entry.chainId,
    ...(entry.expiry && entry.expiry > 0
      ? { expires_at: new Date(entry.expiry * 1000).toISOString() }
      : {}),
    ...(entry.key ? { key: entry.key } : {}),
    ...(entry.keyStorage ? { key_storage: entry.keyStorage } : {}),
    network: network.name,
    ...(entry.limits.length > 0 ? { spending_limit: storedSpendingLimit(entry, tokenInfo) } : {}),
    symbol: tokenInfo.symbol,
    token: tokenInfo.address,
    wallet_address: normalizeAddress(entry.walletAddress),
    wallet_type: entry.walletType
  }
}

async function queryBalance(network: Network, wallet: Address.Address, token: ResolvedToken) {
  const balance = await publicClient(network).readContract({
    abi: Abis.tip20,
    address: token.address,
    args: [wallet],
    functionName: 'balanceOf'
  })
  return formatUnits(balance, token.decimals)
}

async function resolveToken(network: Network, input: string): Promise<ResolvedToken> {
  const address = normalizeAddress(input)
  if (address === normalizeAddress(network.token.address)) {
    return {
      address,
      decimals: network.token.decimals,
      symbol: network.token.symbol
    }
  }

  const client = publicClient(network)
  const [decimals, symbol] = await Promise.all([
    client.readContract({ abi: Abis.tip20, address, functionName: 'decimals' }),
    client.readContract({ abi: Abis.tip20, address, functionName: 'symbol' }).catch(() => address)
  ])
  return { address, decimals: Number(decimals), symbol: String(symbol) }
}

async function accountForEntry(entry: KeyEntry) {
  if (entry.keyStorage === 'secure-enclave')
    throw new Error(
      'Secure Enclave signing is not wired yet. Create a revocable local access key for automation.'
    )
  const key = (entry.key ??
    (entry.keyReference ? await loadKeychainSecret(entry.keyReference) : undefined)) as
    | Hex.Hex
    | undefined
  if (!key) throw new Error('No key configured.')
  const wallet = normalizeAddress(entry.walletAddress)
  const keyAddress = entry.keyAddress ? normalizeAddress(entry.keyAddress) : undefined
  if (!keyAddress || wallet === keyAddress) return Account.fromSecp256k1(key)
  return Account.fromSecp256k1(key, { access: wallet })
}

export function chainForNetwork(network: Network) {
  const chain = network.name === 'tempo' ? tempo : tempoModerato
  return chain.extend({
    feeToken: network.token.address,
    rpcUrls: { default: { http: [network.rpcUrl] } }
  })
}

function formatLimit(key: Pick<KeyInfo, 'spending_limit' | 'symbol'>) {
  const limit = key.spending_limit
  if (!limit) return ''
  const symbol = key.symbol ?? 'tokens'
  if (limit.unlimited) return field('Limit', `unlimited ${symbol}`)
  if (limit.remaining)
    return field(
      'Limit',
      `${limit.spent ?? '0'} / ${limit.limit ?? '?'} ${symbol} (${limit.remaining} remaining)`
    )
  return ''
}

function formatExpiry(expiry: number | undefined) {
  if (!expiry) return undefined
  const remaining = expiry - Math.floor(Date.now() / 1000)
  if (remaining <= 0) return 'expired'
  const days = Math.floor(remaining / 86400)
  const hours = Math.floor((remaining % 86400) / 3600)
  const minutes = Math.floor((remaining % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function formatUnits(value: bigint, decimals: number) {
  const scale = 10n ** BigInt(decimals)
  const whole = value / scale
  const fraction = value % scale
  if (fraction === 0n) return whole.toString()
  const padded = fraction.toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${whole}.${padded}`
}

function field(label: string, value: string) {
  return `${label.padStart(10)}: ${value}`
}

function networkForEntry(fallback: Network, entry: KeyEntry) {
  return networkFromChainId(entry.chainId) ?? fallback
}

function parseStoredKeyAuthorization(entry: KeyEntry) {
  if (!entry.keyAuthorization) return undefined
  const auth = KeyAuthorization.deserialize(entry.keyAuthorization)
  if (!auth.signature) return undefined
  assertSignedKeyAuthorization(auth)
  return auth
}

function assertSignedKeyAuthorization(
  auth: KeyAuthorization.KeyAuthorization
): asserts auth is KeyAuthorization.Signed {
  if (!auth.signature) throw new Error('Key authorization is missing a signature.')
}

function publicClient(network: Network) {
  return createPublicClient({
    chain: chainForNetwork(network),
    transport: http(network.rpcUrl)
  })
}

function requireNetworkKey(entries: readonly KeyEntry[], network: Network) {
  const key = keyForNetwork(entries, network.chainId)
  if (!key)
    throw new Error(`No key configured for network '${network.name}'. Run 'tempo wallet login'.`)
  if (!key.key && !key.keyReference && key.keyStorage !== 'secure-enclave')
    throw new Error('No key configured.')
  return key
}

function resolveAmount(input: string, token: ResolvedToken) {
  const amount = parseUnits(input, token.decimals)
  if (amount <= 0n)
    throw new Error(
      amount === 0n ? 'Amount must be greater than zero.' : 'Amount must be positive.'
    )
  return amount
}

function shortAddress(address: string) {
  return address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address
}

function storedSpendingLimit(entry: KeyEntry, token: ResolvedToken): SpendingLimitInfo {
  const limit = entry.limits.find(limit => normalizeAddress(limit.currency) === token.address)
  if (!limit) return { unlimited: true }
  return {
    limit: formatUnits(BigInt(limit.limit), token.decimals),
    remaining: formatUnits(BigInt(limit.limit), token.decimals),
    spent: '0',
    unlimited: false
  }
}

function transferResponse(input: {
  amount: string
  chainId: number
  from: string
  status: 'dry_run' | 'success'
  symbol: string
  to: string
  token: string
  txHash?: Hex.Hex | undefined
}) {
  return {
    amount: input.amount,
    chain_id: input.chainId,
    from: input.from,
    status: input.status,
    symbol: input.symbol,
    to: input.to,
    token: input.token,
    ...(input.txHash ? { tx_hash: input.txHash } : {})
  }
}

async function withProvisioningRetry<T>(
  optimistic: () => Promise<T>,
  retry: () => Promise<T>,
  keyAuthorization: KeyAuthorization.Signed | undefined
) {
  try {
    return await optimistic()
  } catch (error) {
    if (!keyAuthorization) throw error
    return await retry()
  }
}

function txUrl(network: Network, txHash: Hex.Hex) {
  return `${network.explorerUrl}/receipt/${txHash}`
}

export type ResolvedToken = {
  address: Address.Address
  decimals: number
  symbol: string
}

import { Address, Hex } from 'ox'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeFS from 'node:fs/promises'

export type KeyType = 'secp256k1' | 'p256' | 'webauthn'
export type WalletType = 'local' | 'passkey'

export type StoredTokenLimit = {
  limit: string
  currency: Address.Address
}

export type KeyEntry = {
  chainId: number
  keyType: KeyType
  walletAddress: string
  walletType: WalletType
  key?: Hex.Hex | undefined
  expiry?: number | undefined
  limits: Array<StoredTokenLimit>
  keyAddress?: Address.Address | undefined
  keyAuthorization?: `0x${string}` | undefined
}

export function keysPath() {
  const tempoHome = process.env.TEMPO_HOME ?? NodePath.join(NodeOS.homedir(), '.tempo')
  return NodePath.join(tempoHome, 'wallet', 'keys.toml')
}

export async function loadKeystore(path = keysPath()): Promise<KeyEntry[]> {
  try {
    return parseKeystore(await NodeFS.readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function saveKeystore(keys: readonly KeyEntry[], path = keysPath()) {
  await NodeFS.mkdir(NodePath.dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await NodeFS.writeFile(tmp, stringifyKeystore(keys), { encoding: 'utf8', mode: 0o600 })
  await NodeFS.rename(tmp, path)
}

export function hasWallet(keys: readonly KeyEntry[]) {
  const key = primaryKey(keys)
  return Boolean(key?.walletAddress && key.key && isAddress(key.walletAddress))
}

export function hasKeyForNetwork(keys: readonly KeyEntry[], chainId: number) {
  return hasWallet(keys) && keys.some(key => key.chainId === chainId)
}

export function keyForNetwork(keys: readonly KeyEntry[], chainId: number) {
  return keys.find(key => key.chainId === chainId) ?? keys.find(isDirectEoaKey)
}

export function findPasskeyWallet(keys: readonly KeyEntry[]) {
  return keys.find(key => key.walletType === 'passkey')
}

export function deletePasskeyWalletAddress(keys: readonly KeyEntry[], walletAddress: string) {
  const normalized = normalizeAddress(walletAddress)
  const next = keys.filter(
    key =>
      !(key.walletType === 'passkey' && normalizeMaybeAddress(key.walletAddress) === normalized)
  )
  if (next.length === keys.length) throw new Error(`No passkey wallet found for '${normalized}'.`)
  return next
}

export function upsertKey(keys: readonly KeyEntry[], entry: KeyEntry) {
  const normalized = normalizeAddress(entry.walletAddress)
  const without = keys.filter(
    key =>
      !(normalizeMaybeAddress(key.walletAddress) === normalized && key.chainId === entry.chainId)
  )
  return [...without, { ...entry, walletAddress: normalized }]
}

export function normalizeAddress(value: string) {
  const normalized = normalizeAddressInput(value)
  if (!isAddress(normalized)) throw new Error(`Invalid address: ${value}`)
  return Address.checksum(normalized as `0x${string}`).toLowerCase()
}

function normalizeMaybeAddress(value: string | undefined) {
  if (!value) return undefined
  const normalized = normalizeAddressInput(value)
  if (!isAddress(normalized)) return undefined
  return Address.checksum(normalized as `0x${string}`).toLowerCase()
}

function normalizeAddressInput(value: string) {
  const trimmed = value.trim()
  if (!/^tempox/i.test(trimmed)) return trimmed
  const stripped = trimmed.replace(/^tempox/i, '')
  return stripped.startsWith('0x') ? stripped : `0x${stripped}`
}

function primaryKey(keys: readonly KeyEntry[]) {
  return (
    keys.find(key => key.walletType === 'passkey') ??
    keys.find(key => key.key && key.key.length > 0) ??
    keys[0]
  )
}

function isDirectEoaKey(key: KeyEntry) {
  const wallet = normalizeMaybeAddress(key.walletAddress)
  const signer = normalizeMaybeAddress(key.keyAddress)
  return key.walletType === 'local' && Boolean(wallet && signer && wallet === signer && key.key)
}

function isAddress(value: string): value is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(value)
}

function parseKeystore(text: string) {
  const keys: KeyEntry[] = []
  let key: Partial<KeyEntry> | undefined
  let limit: Partial<StoredTokenLimit> | undefined

  function flushLimit() {
    if (!key || !limit?.currency || typeof limit.limit !== 'string') return
    key.limits = [...(key.limits ?? []), limit as StoredTokenLimit]
    limit = undefined
  }

  function flushKey() {
    flushLimit()
    if (!key?.walletAddress) {
      key = undefined
      return
    }
    if (!isAddress(key.walletAddress)) {
      key = undefined
      return
    }
    keys.push({
      chainId: key.chainId ?? 0,
      ...(typeof key.expiry === 'number' ? { expiry: key.expiry } : {}),
      ...(key.key ? { key: key.key } : {}),
      ...(key.keyAddress ? { keyAddress: normalizeAddress(key.keyAddress) as `0x${string}` } : {}),
      ...(key.keyAuthorization ? { keyAuthorization: key.keyAuthorization } : {}),
      keyType: key.keyType ?? 'secp256k1',
      limits: key.limits ?? [],
      walletAddress: normalizeAddress(key.walletAddress),
      walletType: key.walletType ?? 'local'
    })
    key = undefined
  }

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue

    if (line === '[[keys]]') {
      flushKey()
      key = {}
      continue
    }

    if (line === '[[keys.limits]]') {
      flushLimit()
      limit = {}
      continue
    }

    const match = line.match(/^([a-z_]+)\s*=\s*(.+)$/)
    if (!match) continue
    const [, name, rawValue] = match
    const value = stripQuotes(rawValue!.trim())

    if (limit) {
      if (name === 'currency') limit.currency = normalizeAddress(value) as `0x${string}`
      if (name === 'limit') limit.limit = value
      continue
    }

    if (!key) continue
    if (name === 'wallet_type') key.walletType = value as WalletType
    if (name === 'wallet_address') key.walletAddress = value
    if (name === 'chain_id') key.chainId = Number.parseInt(value, 10)
    if (name === 'key_type') key.keyType = value as KeyType
    if (name === 'key_address') key.keyAddress = value as `0x${string}`
    if (name === 'key') key.key = value as `0x${string}`
    if (name === 'key_authorization') key.keyAuthorization = value as `0x${string}`
    if (name === 'expiry') key.expiry = Number.parseInt(value, 10)
  }

  flushKey()
  return keys
}

function stringifyKeystore(keys: readonly KeyEntry[]) {
  return [
    '# Tempo wallet keys - managed by `tempo wallet`',
    '# Do not edit manually.',
    '',
    ...keys.flatMap(key => [
      '[[keys]]',
      `wallet_type = "${key.walletType}"`,
      `wallet_address = "${key.walletAddress}"`,
      `chain_id = ${key.chainId}`,
      `key_type = "${key.keyType}"`,
      ...(key.keyAddress ? [`key_address = "${key.keyAddress}"`] : []),
      ...(key.key ? [`key = "${key.key}"`] : []),
      ...(key.keyAuthorization ? [`key_authorization = "${key.keyAuthorization}"`] : []),
      ...(typeof key.expiry === 'number' ? [`expiry = ${key.expiry}`] : []),
      '',
      ...key.limits.flatMap(limit => [
        '[[keys.limits]]',
        `currency = "${limit.currency}"`,
        `limit = "${limit.limit}"`,
        ''
      ])
    ])
  ].join('\n')
}

function stripQuotes(value: string) {
  return value.replace(/^"|"$/g, '')
}

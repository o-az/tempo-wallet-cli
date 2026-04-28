import { Address, Hex } from 'ox'
import * as toml from '@std/toml'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeFS from 'node:fs/promises'
import type { SignatureEnvelope } from 'ox/tempo'

export type KeyType = Lowercase<SignatureEnvelope.Type>
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

type TomlKey = {
  chain_id?: unknown
  expiry?: unknown
  key?: unknown
  key_address?: unknown
  key_authorization?: unknown
  key_type?: unknown
  limits?: unknown
  wallet_address?: unknown
  wallet_type?: unknown
}

type TomlLimit = {
  currency?: unknown
  limit?: unknown
}

function parseKeystore(text: string) {
  const data = toml.parse(text)
  const keys = Array.isArray(data.keys) ? data.keys : []

  return keys.flatMap((rawKey): KeyEntry[] => {
    if (!isTomlKey(rawKey) || typeof rawKey.wallet_address !== 'string') return []
    if (!isAddress(rawKey.wallet_address)) return []

    const limits = (Array.isArray(rawKey.limits) ? rawKey.limits : []).flatMap(
      (rawLimit): StoredTokenLimit[] => {
        if (
          !isTomlLimit(rawLimit) ||
          typeof rawLimit.currency !== 'string' ||
          typeof rawLimit.limit !== 'string'
        )
          return []
        return [
          { currency: normalizeAddress(rawLimit.currency) as `0x${string}`, limit: rawLimit.limit }
        ]
      }
    )

    return [
      {
        chainId: typeof rawKey.chain_id === 'number' ? rawKey.chain_id : 0,
        ...(typeof rawKey.expiry === 'number' ? { expiry: rawKey.expiry } : {}),
        ...(typeof rawKey.key === 'string' ? { key: rawKey.key as `0x${string}` } : {}),
        ...(typeof rawKey.key_address === 'string'
          ? { keyAddress: normalizeAddress(rawKey.key_address) as `0x${string}` }
          : {}),
        ...(typeof rawKey.key_authorization === 'string'
          ? { keyAuthorization: rawKey.key_authorization as `0x${string}` }
          : {}),
        keyType: typeof rawKey.key_type === 'string' ? (rawKey.key_type as KeyType) : 'secp256k1',
        limits,
        walletAddress: normalizeAddress(rawKey.wallet_address),
        walletType:
          typeof rawKey.wallet_type === 'string' ? (rawKey.wallet_type as WalletType) : 'local'
      }
    ]
  })
}

function stringifyKeystore(keys: readonly KeyEntry[]) {
  const data = {
    keys: keys.map(key => ({
      wallet_type: key.walletType,
      wallet_address: key.walletAddress,
      chain_id: key.chainId,
      key_type: key.keyType,
      ...(key.keyAddress ? { key_address: key.keyAddress } : {}),
      ...(key.key ? { key: key.key } : {}),
      ...(key.keyAuthorization ? { key_authorization: key.keyAuthorization } : {}),
      ...(typeof key.expiry === 'number' ? { expiry: key.expiry } : {}),
      limits: key.limits.map(limit => ({
        currency: limit.currency,
        limit: limit.limit
      }))
    }))
  }

  return [
    '# Tempo wallet keys - managed by `tempo wallet`',
    '# Do not edit manually.',
    toml.stringify(data).trimEnd(),
    ''
  ].join('\n')
}

function isTomlKey(value: unknown): value is TomlKey {
  return typeof value === 'object' && value !== null
}

function isTomlLimit(value: unknown): value is TomlLimit {
  return typeof value === 'object' && value !== null
}

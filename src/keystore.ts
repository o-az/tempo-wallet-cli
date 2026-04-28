import { z } from 'incur'
import { Address, Hex } from 'ox'
import * as toml from '@std/toml'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeFS from 'node:fs/promises'

const keyTypeSchema = z.enum(['secp256k1', 'p256', 'webauthn'])
const walletTypeSchema = z.enum(['local', 'passkey'])

const addressSchema = z.custom<Address.Address>(
  value => typeof value === 'string' && Address.validate(value)
)
const hexSchema = z.custom<Hex.Hex>(value => typeof value === 'string' && Hex.validate(value))

export type KeyType = z.infer<typeof keyTypeSchema>
export type WalletType = z.infer<typeof walletTypeSchema>

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
  keyAuthorization?: Hex.Hex | undefined
}

export function keysPath() {
  const tempoHome = process.env.TEMPO_HOME ?? NodePath.join(NodeOS.homedir(), '.tempo')
  return NodePath.join(tempoHome, 'wallet', 'keys.toml')
}

export async function loadKeystore(path = keysPath()): Promise<KeyEntry[]> {
  try {
    return parseKeystore(await NodeFS.readFile(path, 'utf8'))
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
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
  return Boolean(key?.walletAddress && key.key && Address.validate(key.walletAddress))
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

export function normalizeAddress(value: string): Address.Address {
  const normalized = normalizeAddressInput(value)
  if (!Address.validate(normalized)) throw new Error(`Invalid address: ${value}`)
  return Address.from(Address.checksum(normalized).toLowerCase())
}

function normalizeMaybeAddress(value: string | undefined) {
  if (!value) return undefined
  const normalized = normalizeAddressInput(value)
  if (!Address.validate(normalized)) return undefined
  return Address.from(Address.checksum(normalized).toLowerCase())
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

const tomlLimitSchema = z.object({
  currency: z.string(),
  limit: z.string()
})

const tomlKeySchema = z.object({
  chain_id: z.number().optional(),
  expiry: z.number().optional(),
  key: hexSchema.optional(),
  key_address: z.string().optional(),
  key_authorization: hexSchema.optional(),
  key_type: keyTypeSchema.optional(),
  limits: z.array(tomlLimitSchema).optional(),
  wallet_address: addressSchema,
  wallet_type: walletTypeSchema.optional()
})

const tomlKeystoreSchema = z.object({
  keys: z.array(z.unknown()).optional()
})

function parseKeystore(text: string) {
  const data = tomlKeystoreSchema.parse(toml.parse(text))

  return (data.keys ?? []).flatMap((raw): KeyEntry[] => {
    const parsed = tomlKeySchema.safeParse(raw)
    if (!parsed.success) return []
    const rawKey = parsed.data

    const limits = (rawKey.limits ?? []).map(
      (limit): StoredTokenLimit => ({
        currency: normalizeAddress(limit.currency),
        limit: limit.limit
      })
    )

    return [
      {
        chainId: rawKey.chain_id ?? 0,
        ...(typeof rawKey.expiry === 'number' ? { expiry: rawKey.expiry } : {}),
        ...(rawKey.key ? { key: rawKey.key } : {}),
        ...(rawKey.key_address ? { keyAddress: normalizeAddress(rawKey.key_address) } : {}),
        ...(rawKey.key_authorization ? { keyAuthorization: rawKey.key_authorization } : {}),
        keyType: rawKey.key_type ?? 'secp256k1',
        limits,
        walletAddress: normalizeAddress(rawKey.wallet_address),
        walletType: rawKey.wallet_type ?? 'local'
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

function errorCode(error: unknown) {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

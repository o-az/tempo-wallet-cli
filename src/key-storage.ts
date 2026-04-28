import * as NodeChildProcess from 'node:child_process'
import * as NodeCrypto from 'node:crypto'
import * as NodeFS from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { Address, Hex, PublicKey } from 'ox'

const keychainService = 'tempo-wallet'

type PlatformSecretStorage = {
  activeStorage: 'file' | 'keychain'
  provider: string
  status: 'active' | 'unsupported_noop'
  sync: 'keychain_default' | 'local_file'
}

type PlatformHardwareStorage = {
  activeStorage: 'file' | 'secure-enclave'
  provider: string
  status: 'active' | 'unsupported_noop'
  sync: 'device_only' | 'local_file'
}

type SecureEnclaveIdentity = {
  address: Address.Address
  hash: string
  label: string
  publicKey: Hex.Hex
}

export type StoredWalletIndexEntry = {
  address: Address.Address
  chainId: number
  provider: string
  reference: string
  type: 'hardware' | 'local'
}

type SecureEnclaveSignature = {
  publicKey: Hex.Hex
  signature: {
    r: bigint
    s: bigint
    yParity: 0
  }
}

export function keychainReference(chainId: number, walletAddress: string) {
  return `${chainId}:${walletAddress.toLowerCase()}`
}

export function platformSecretStorage(): PlatformSecretStorage {
  switch (process.platform) {
    case 'darwin':
      return {
        activeStorage: 'keychain',
        provider: 'macos-keychain',
        status: 'active',
        sync: 'keychain_default'
      }
    case 'win32':
      return {
        activeStorage: 'file',
        provider: 'windows-credential-manager',
        status: 'unsupported_noop',
        sync: 'local_file'
      }
    case 'linux':
      return {
        activeStorage: 'file',
        provider: 'linux-secret-service',
        status: 'unsupported_noop',
        sync: 'local_file'
      }
    default:
      return {
        activeStorage: 'file',
        provider: `${process.platform}-secret-storage`,
        status: 'unsupported_noop',
        sync: 'local_file'
      }
  }
}

export function platformHardwareStorage(): PlatformHardwareStorage {
  switch (process.platform) {
    case 'darwin':
      return {
        activeStorage: 'secure-enclave',
        provider: 'macos-secure-enclave',
        status: 'active',
        sync: 'device_only'
      }
    case 'win32':
      return {
        activeStorage: 'file',
        provider: 'windows-tpm-cng',
        status: 'unsupported_noop',
        sync: 'local_file'
      }
    case 'linux':
      return {
        activeStorage: 'file',
        provider: 'linux-hardware-keystore',
        status: 'unsupported_noop',
        sync: 'local_file'
      }
    default:
      return {
        activeStorage: 'file',
        provider: `${process.platform}-hardware-keystore`,
        status: 'unsupported_noop',
        sync: 'local_file'
      }
  }
}

export function supportsKeychain() {
  return platformSecretStorage().activeStorage === 'keychain'
}

export async function storeKeychainSecret(reference: string, value: string) {
  if (!supportsKeychain()) return false
  runSecurity(['add-generic-password', '-U', '-s', keychainService, '-a', reference, '-w', value])
  return true
}

export async function indexStoredWallet(entry: StoredWalletIndexEntry) {
  if (!supportsKeychain()) return false
  const index = await listStoredWalletIndex()
  const next = [
    ...index.filter(
      item => !(item.chainId === entry.chainId && Address.isEqual(item.address, entry.address))
    ),
    entry
  ]
  await storeKeychainSecret('wallet_index', JSON.stringify(next))
  return true
}

export async function listStoredWalletIndex(): Promise<StoredWalletIndexEntry[]> {
  if (!supportsKeychain()) return []
  try {
    const raw = await loadKeychainSecret('wallet_index')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item): StoredWalletIndexEntry[] => {
      if (!isRecord(item)) return []
      if (
        typeof item.address !== 'string' ||
        typeof item.chainId !== 'number' ||
        typeof item.provider !== 'string' ||
        typeof item.reference !== 'string' ||
        (item.type !== 'hardware' && item.type !== 'local') ||
        !Address.validate(item.address)
      )
        return []
      return [
        {
          address: Address.from(Address.checksum(item.address).toLowerCase()),
          chainId: item.chainId,
          provider: item.provider,
          reference: item.reference,
          type: item.type
        }
      ]
    })
  } catch {
    return []
  }
}

export async function loadKeychainSecret(reference: string) {
  if (!supportsKeychain()) throw new Error('Keychain storage is only supported on macOS.')
  const result = runSecurity([
    'find-generic-password',
    '-s',
    keychainService,
    '-a',
    reference,
    '-w'
  ])
  return result.stdout.trim()
}

export async function listSecureEnclaveIdentities(): Promise<SecureEnclaveIdentity[]> {
  if (process.platform !== 'darwin') return []
  const result = runCommand('swift', [
    NodePath.join(
      NodePath.dirname(fileURLToPath(import.meta.url)),
      'macos-secure-enclave-list.swift'
    )
  ])
  const parsed = JSON.parse(result.stdout)
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((item): SecureEnclaveIdentity[] => {
    if (!isRecord(item)) return []
    if (
      typeof item.label !== 'string' ||
      !item.label.startsWith('tempo_wallet_') ||
      typeof item.hash !== 'string' ||
      typeof item.publicKey !== 'string' ||
      !Hex.validate(item.publicKey)
    )
      return []
    const publicKey = normalizeP256PublicKey(item.publicKey)
    const identity = findSecureEnclaveIdentity(item.label)
    return [
      {
        address: Address.fromPublicKey(PublicKey.from(publicKey)),
        hash: identity?.hash ?? item.hash,
        label: item.label,
        publicKey
      }
    ]
  })
}

export async function signSecureEnclaveDigest(
  label: string,
  digest: Hex.Hex
): Promise<SecureEnclaveSignature> {
  if (process.platform !== 'darwin')
    throw new Error('Secure Enclave signing is only supported on macOS.')
  const result = runCommand('swift', [
    NodePath.join(
      NodePath.dirname(fileURLToPath(import.meta.url)),
      'macos-secure-enclave-sign.swift'
    ),
    label,
    digest
  ])
  const parsed = JSON.parse(result.stdout) as { publicKey?: unknown; signature?: unknown }
  if (typeof parsed.publicKey !== 'string' || !Hex.validate(parsed.publicKey))
    throw new Error('Secure Enclave signer returned an invalid public key.')
  if (typeof parsed.signature !== 'string' || !Hex.validate(parsed.signature))
    throw new Error('Secure Enclave signer returned an invalid signature.')
  return {
    publicKey: normalizeP256PublicKey(parsed.publicKey),
    signature: { ...parseDerEcdsaSignature(parsed.signature), yParity: 0 }
  }
}

export async function createSecureEnclaveIdentity(label: string): Promise<SecureEnclaveIdentity> {
  if (process.platform !== 'darwin')
    throw new Error('--hardware-encryption requires macOS Secure Enclave support.')

  runCommand('sc_auth', ['create-ctk-identity', '-l', label, '-k', 'p-256-ne', '-t', 'bio'])
  const identity = findSecureEnclaveIdentity(label)
  if (!identity) throw new Error(`Secure Enclave identity '${label}' was not created.`)

  const publicKey = await exportSecureEnclavePublicKey(identity.hash)
  return {
    ...identity,
    address: Address.fromPublicKey(PublicKey.from(publicKey)),
    publicKey
  }
}

function findSecureEnclaveIdentity(label: string) {
  const result = runCommand('sc_auth', ['list-ctk-identities'])
  for (const line of result.stdout.split('\n')) {
    if (!line.includes(label)) continue
    const parts = line.trim().split(/\s+/)
    const hash = parts[1]
    const parsedLabel = parts[3]
    if (hash && parsedLabel === label) return { hash, label: parsedLabel }
  }
  return undefined
}

async function exportSecureEnclavePublicKey(hash: string): Promise<Hex.Hex> {
  const dir = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'tempo-secure-enclave-'))
  const csrPath = NodePath.join(dir, 'key.csr')
  try {
    runCommand('sc_auth', ['create-ctk-csr', '-h', hash, '-f', csrPath])
    const pem = runCommand('openssl', ['req', '-in', csrPath, '-pubkey', '-noout']).stdout
    return publicKeyPemToHex(pem)
  } finally {
    await NodeFS.rm(dir, { force: true, recursive: true }).catch(() => undefined)
  }
}

function publicKeyPemToHex(pem: string): Hex.Hex {
  const key = NodeCrypto.createPublicKey(pem)
  const jwk = key.export({ format: 'jwk' }) as JsonWebKey
  if (!jwk.x || !jwk.y) throw new Error('Secure Enclave public key is missing P-256 coordinates.')
  return Hex.fromBytes(
    Uint8Array.from([...Buffer.from(jwk.x, 'base64url'), ...Buffer.from(jwk.y, 'base64url')])
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeP256PublicKey(publicKey: Hex.Hex) {
  const bytes = Hex.toBytes(publicKey)
  if (bytes.length === 65 && bytes[0] === 4) return Hex.fromBytes(bytes.slice(1))
  if (bytes.length === 64) return publicKey
  throw new Error(`Expected a P-256 public key, got ${bytes.length} bytes.`)
}

function parseDerEcdsaSignature(signature: Hex.Hex) {
  const bytes = Hex.toBytes(signature)
  let offset = 0
  if (bytes[offset++] !== 0x30) throw new Error('Invalid ECDSA signature.')
  offset = readDerLength(bytes, offset).offset
  const r = readDerInteger(bytes, offset)
  const s = readDerInteger(bytes, r.offset)
  return { r: BigInt(Hex.fromBytes(r.bytes)), s: BigInt(Hex.fromBytes(s.bytes)) }
}

function readDerInteger(bytes: Uint8Array, offset: number) {
  if (bytes[offset++] !== 0x02) throw new Error('Invalid ECDSA signature integer.')
  const length = readDerLength(bytes, offset)
  offset = length.offset
  const value = bytes.slice(offset, offset + length.length)
  return { bytes: trimDerInteger(value), offset: offset + length.length }
}

function readDerLength(bytes: Uint8Array, offset: number) {
  const first = bytes[offset++]
  if (first === undefined) throw new Error('Invalid DER length.')
  if (first < 0x80) return { length: first, offset }
  const size = first & 0x7f
  if (size === 0 || size > 2) throw new Error('Unsupported DER length.')
  let length = 0
  for (let index = 0; index < size; index++) {
    const byte = bytes[offset++]
    if (byte === undefined) throw new Error('Invalid DER length.')
    length = (length << 8) | byte
  }
  return { length, offset }
}

function trimDerInteger(bytes: Uint8Array) {
  let offset = 0
  while (offset < bytes.length - 1 && bytes[offset] === 0) offset++
  const trimmed = bytes.slice(offset)
  if (trimmed.length > 32) throw new Error('Invalid ECDSA integer length.')
  const padded = new Uint8Array(32)
  padded.set(trimmed, 32 - trimmed.length)
  return padded
}

function runSecurity(args: string[]) {
  return runCommand('security', args)
}

function runCommand(command: string, args: string[]) {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.status === 0) return { stdout: result.stdout }
  const detail = result.stderr.trim() || result.stdout.trim()
  throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`)
}

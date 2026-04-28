import * as NodeChildProcess from 'node:child_process'
import * as NodeCrypto from 'node:crypto'
import * as NodeFS from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { Address, Hex, PublicKey } from 'ox'

const keychainService = 'tempo-wallet'

type SecureEnclaveIdentity = {
  address: Address.Address
  hash: string
  label: string
  publicKey: Hex.Hex
}

export function keychainReference(chainId: number, walletAddress: string) {
  return `${chainId}:${walletAddress.toLowerCase()}`
}

export function supportsKeychain() {
  return process.platform === 'darwin'
}

export async function storeKeychainSecret(reference: string, value: string) {
  if (!supportsKeychain()) return false
  runSecurity(['add-generic-password', '-U', '-s', keychainService, '-a', reference, '-w', value])
  return true
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

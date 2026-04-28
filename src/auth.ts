import { Base64, Hash, Hex } from 'ox'
import { KeyAuthorization } from 'ox/tempo'
import * as NodeTimers from 'node:timers/promises'
import * as NodeChildProcess from 'node:child_process'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

import {
  keysPath,
  upsertKey,
  loadKeystore,
  saveKeystore,
  type KeyType,
  type KeyEntry,
  keyForNetwork,
  normalizeAddress,
  hasKeyForNetwork,
  findPasskeyWallet,
  type StoredTokenLimit,
  deletePasskeyWalletAddress
} from '#keystore.ts'
import type { Network } from '#network.ts'
import { emit, formatVerificationCode, type GlobalOptions } from '#output.ts'

const callbackTimeoutMs = 15 * 60 * 1_000
const pollIntervalMs = Number.parseInt(process.env.TEMPO_WALLET_POLL_INTERVAL_MS ?? '2000', 10)

export async function login(
  network: Network,
  globals: GlobalOptions,
  options: { noBrowser: boolean }
) {
  await loginImpl(network, globals, { forceReauth: false, noBrowser: options.noBrowser })
}

export async function refresh(network: Network, globals: GlobalOptions) {
  await loginImpl(network, globals, { forceReauth: true, noBrowser: false })
}

export async function logout(globals: GlobalOptions, options: { yes: boolean }) {
  const keys = await loadKeystore()
  const passkey = findPasskeyWallet(keys)

  if (!passkey) {
    emit(
      globals.format,
      { logged_in: false, disconnected: false, message: 'not logged in' },
      () => 'Not logged in.\n'
    )
    return
  }

  const wallet = normalizeAddress(passkey.walletAddress)
  if (!options.yes && !confirm(`Disconnect wallet ${shortAddress(wallet)}?`))
    return emit(
      globals.format,
      { logged_in: true, disconnected: false, wallet, message: 'cancelled' },
      () => 'Cancelled.\n'
    )

  await saveKeystore(deletePasskeyWalletAddress(keys, wallet))
  emit(
    globals.format,
    { logged_in: true, disconnected: true, wallet, message: 'wallet disconnected' },
    () => 'Wallet disconnected.\n'
  )
}

async function loginImpl(
  network: Network,
  globals: GlobalOptions,
  options: { forceReauth: boolean; noBrowser: boolean }
) {
  const keys = await loadKeystore()
  const alreadyLoggedIn = hasKeyForNetwork(keys, network.chainId)

  if (options.forceReauth && alreadyLoggedIn) ensureRefreshSupported(keys, network)

  let staleBackup: KeyEntry[] | undefined
  if (options.forceReauth && alreadyLoggedIn) {
    const entry = keyForNetwork(keys, network.chainId)
    if (entry) {
      staleBackup = keys
      await saveKeystore(deletePasskeyWalletAddress(keys, entry.walletAddress))
      if (globals.format === 'text') process.stderr.write('Refreshing access key...\n')
    }
  }

  if (!alreadyLoggedIn || options.forceReauth) {
    try {
      await doLogin(network, globals, options.noBrowser)
    } catch (error) {
      if (staleBackup) {
        await saveKeystore(staleBackup)
        if (globals.format === 'text')
          process.stderr.write('Access key refresh failed. Restored previous access key.\n')
      }
      throw error
    }
  }

  if (globals.format === 'text' && !globals.silent) {
    if (options.forceReauth && alreadyLoggedIn) process.stderr.write('\nAccess key refreshed!\n\n')
    else if (alreadyLoggedIn) process.stderr.write('Already logged in.\n\n')
    else process.stderr.write('\nWallet connected!\n\n')
  }

  await showWhoami(network, globals)
}

async function doLogin(network: Network, globals: GlobalOptions, noBrowser: boolean) {
  const authServerUrl = process.env.TEMPO_AUTH_URL ?? network.authUrl
  const authUrl = new URL(authServerUrl)
  const authBaseUrl = authUrl.origin

  const privateKey = generatePrivateKey()
  const account = privateKeyToAccount(privateKey)
  const { verifier, challenge } = createPkcePair()

  const code = await createDeviceCode(authBaseUrl, account.publicKey, challenge, network)
  authUrl.searchParams.set('code', code)
  const url = authUrl.toString()

  process.stderr.write(`Auth URL: ${url}\n`)
  const opened = tryOpenBrowser(url, noBrowser)

  if (noBrowser) showRemoteLoginPrompt(url, code)
  else if (globals.format === 'text' && !globals.silent) showLoginPrompt(code)
  if (opened === 'failed') process.stderr.write(`Open this URL manually: ${url}\n`)

  const callback = await pollUntilAuthorized(authBaseUrl, code, verifier)
  await saveLoginKey(network, callback, privateKey, account.address)
}

async function createDeviceCode(
  baseUrl: string,
  publicKey: `0x${string}`,
  codeChallenge: string,
  network: Network
) {
  const legacy = await postJson(`${baseUrl}/cli-auth/device-code`, {
    code_challenge: codeChallenge,
    key_type: 'secp256k1',
    pub_key: publicKey
  })

  const legacyJson = asRecord(legacy.json)
  if (legacy.ok && typeof legacyJson.code === 'string') return legacyJson.code
  if (legacy.status && legacy.status !== 404) throw httpError('request device code', legacy)

  const next = await postJson(`${baseUrl}/cli-auth/code`, {
    chainId: `0x${network.chainId.toString(16)}`,
    codeChallenge,
    keyType: 'secp256k1',
    pubKey: publicKey
  })
  const nextJson = asRecord(next.json)
  if (next.ok && typeof nextJson.code === 'string') return nextJson.code
  throw httpError('request device code', next)
}

async function pollUntilAuthorized(baseUrl: string, code: string, codeVerifier: string) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < callbackTimeoutMs) {
    const response = await postJson(`${baseUrl}/cli-auth/poll/${code}`, {
      code_verifier: codeVerifier,
      codeVerifier
    })

    if (response.status === 404) throw new Error('Login expired before authorization completed.')
    if (!response.ok) throw httpError('poll login status', response)

    const json = asRecord(response.json)
    const status = json.status
    if (typeof json.error === 'string') throw new Error(json.error)
    if (status === 'expired') throw new Error('Login expired before authorization completed.')
    if (status === 'authorized') {
      const accountAddress = json.account_address ?? json.accountAddress
      if (typeof accountAddress !== 'string') throw new Error('Missing authorized account address.')
      return {
        accountAddress,
        durationSecs: Math.floor((Date.now() - startedAt) / 1000),
        keyAuthorization: json.key_authorization ?? json.keyAuthorization
      }
    }

    await NodeTimers.setTimeout(pollIntervalMs)
  }

  throw new Error('Login expired before authorization completed.')
}

async function saveLoginKey(
  network: Network,
  callback: { accountAddress: string; keyAuthorization: unknown },
  privateKey: `0x${string}`,
  keyAddress: string
) {
  const walletAddress = normalizeAddress(callback.accountAddress)
  const parsed = parseKeyAuthorization(callback.keyAuthorization, keyAddress)
  const entry: KeyEntry = {
    chainId: parsed?.chainId && parsed.chainId !== 0 ? parsed.chainId : network.chainId,
    ...(typeof parsed?.expiry === 'number' ? { expiry: parsed.expiry } : {}),
    key: privateKey,
    keyAddress: normalizeAddress(keyAddress) as `0x${string}`,
    ...(parsed?.hex ? { keyAuthorization: parsed.hex } : {}),
    keyType: parsed?.keyType ?? 'secp256k1',
    limits: parsed?.limits ?? [],
    walletAddress,
    walletType: 'passkey'
  }

  await saveKeystore(upsertKey(await loadKeystore(), entry), keysPath())
}

function parseKeyAuthorization(value: unknown, expectedKeyAddress: string) {
  if (value == null) return undefined

  const signed =
    typeof value === 'string'
      ? KeyAuthorization.deserialize(value as `0x${string}`)
      : KeyAuthorization.fromRpc(value as KeyAuthorization.Rpc)
  if (!signed.signature) throw new Error('Key authorization is missing a signature.')

  const keyAddress = normalizeAddress(signed.address)
  if (keyAddress !== normalizeAddress(expectedKeyAddress))
    throw new Error(`Invalid key authorization target: ${keyAddress}`)

  return {
    chainId: Number(signed.chainId),
    expiry: signed.expiry ?? 0,
    hex: typeof value === 'string' ? (value as `0x${string}`) : KeyAuthorization.serialize(signed),
    keyType: keyTypeToStored(signed.type),
    limits: signed.limits?.map(
      (limit): StoredTokenLimit => ({
        currency: normalizeAddress(limit.token) as `0x${string}`,
        limit: String(limit.limit)
      })
    )
  }
}

async function showWhoami(network: Network, globals: GlobalOptions) {
  const keys = await loadKeystore()
  const key = keyForNetwork(keys, network.chainId)
  const response = buildWhoamiResponse(network, key)

  if (globals.format !== 'text') return emit(globals.format, response, () => undefined)

  if (!key || !response.wallet) {
    process.stdout.write('Not logged in. Run `tempo wallet login` to get started.\n')
    return
  }

  const lines = [`${'Wallet'.padStart(10)}: ${response.wallet}`]
  if (response.key) {
    lines.push('')
    lines.push(`${'Key'.padStart(10)}: ${response.key.address}`)
    lines.push(`${'Chain'.padStart(10)}: ${network.name}`)
    if (response.key.expires_at)
      lines.push(`${'Expires'.padStart(10)}: ${formatExpiry(key.expiry)}`)
  }
  process.stdout.write(`${lines.join('\n')}\n`)
}

function buildWhoamiResponse(network: Network, key: KeyEntry | undefined) {
  if (!key)
    return {
      ready: false
    }

  const wallet = normalizeAddress(key.walletAddress)
  return {
    ready: Boolean(wallet && (key.key || key.keyAuthorization)),
    wallet,
    key: {
      address: key.keyAddress ? normalizeAddress(key.keyAddress) : 'none',
      chain_id: network.chainId,
      expires_at:
        key.expiry && key.expiry > 0 ? new Date(key.expiry * 1000).toISOString() : undefined,
      network: network.name,
      symbol: key.limits.length > 0 ? network.token.symbol : undefined,
      token: key.limits.length > 0 ? network.token.address : undefined
    }
  }
}

function ensureRefreshSupported(keys: readonly KeyEntry[], network: Network) {
  const key = keyForNetwork(keys, network.chainId)
  if (!key || key.walletType === 'passkey') return
  throw new Error(
    "Access-key refresh is only supported for passkey wallets. Run 'tempo wallet login' to re-authorize this wallet."
  )
}

function showLoginPrompt(code: string) {
  process.stderr.write(`Verification code: ${formatVerificationCode(code)}\n\n`)
  process.stderr.write('Waiting for authentication...\n')
}

function showRemoteLoginPrompt(authUrl: string, code: string) {
  process.stderr.write(`Open this link on your device: ${authUrl}\n`)
  process.stderr.write(`Verification code: ${formatVerificationCode(code)}\n`)
  process.stderr.write('If the wallet page shows that same code, tap Continue.\n')
  process.stderr.write(
    'After passkey or wallet creation, return here. If needed, one more authorization link may still be required before this host is ready.\n\n'
  )
  process.stderr.write('Waiting for authentication...\n')
}

function tryOpenBrowser(url: string, noBrowser: boolean) {
  if (process.env.TEMPO_WALLET_DISABLE_BROWSER_OPEN === '1') return 'skipped'
  if (noBrowser) return 'skipped'
  const command =
    process.platform === 'darwin'
      ? { command: 'open', args: [url] }
      : process.platform === 'win32'
        ? { command: 'cmd', args: ['/c', 'start', '', url] }
        : { command: 'xdg-open', args: [url] }

  try {
    const child = NodeChildProcess.spawn(command.command, command.args, {
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
    return 'opened'
  } catch (error) {
    process.stderr.write(
      `Failed to open browser: ${error instanceof Error ? error.message : String(error)}\n`
    )
    return 'failed'
  }
}

function createPkcePair() {
  const verifier = Base64.fromBytes(Hex.toBytes(Hex.random(32)), { pad: false, url: true })
  const challenge = Base64.fromBytes(Hash.sha256(Hex.fromString(verifier), { as: 'Bytes' }), {
    pad: false,
    url: true
  })
  return { challenge, verifier }
}

async function postJson(url: string, body: unknown) {
  try {
    const response = await fetch(url, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'POST'
    })
    const text = await response.text()
    const json = text ? JSON.parse(text) : {}
    return { json, ok: response.ok, status: response.status }
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error))
  }
}

function httpError(operation: string, response: { json: unknown; status: number }) {
  const message =
    typeof response.json === 'object' &&
    response.json !== null &&
    'error' in response.json &&
    typeof response.json.error === 'string'
      ? response.json.error
      : JSON.stringify(response.json)
  return new Error(`${operation} failed with HTTP ${response.status}: ${message}`)
}

function keyTypeToStored(value: string): KeyType {
  if (value === 'p256') return 'p256'
  if (value === 'webAuthn') return 'webauthn'
  return 'secp256k1'
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function confirm(message: string) {
  if (!process.stdin.isTTY) throw new Error('Use --yes for non-interactive mode.')
  process.stderr.write(`${message} [y/N] `)
  const answer = prompt('')
  return answer?.trim().toLowerCase().startsWith('y') ?? false
}

function shortAddress(address: string) {
  return address.length > 10 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address
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

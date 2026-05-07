import { z } from 'incur'
import { KeyAuthorization } from 'ox/tempo'
import { Address, Base64, Hash, Hex } from 'ox'
import * as NodeTimers from 'node:timers/promises'
import * as NodeChildProcess from 'node:child_process'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Account } from 'viem/tempo'

import {
  createSecureEnclaveIdentity,
  indexStoredWallet,
  keychainReference,
  loadKeychainSecret,
  listSecureEnclaveIdentities,
  listStoredWalletIndex,
  platformHardwareStorage,
  platformSecretStorage,
  storeKeychainSecret
} from '#key-storage.ts'
import {
  keysPath,
  upsertKey,
  type KeyType,
  loadKeystore,
  saveKeystore,
  type KeyEntry,
  keyForNetwork,
  normalizeAddress,
  hasKeyForNetwork,
  findPasskeyWallet,
  type StoredTokenLimit,
  deletePasskeyWalletAddress
} from '#keystore.ts'
import { showWhoami } from '#wallet.ts'
import { networkFromChainId, networks, type Network } from '#network.ts'
import { shouldRenderText, formatVerificationCode, type GlobalOptions } from '#output.ts'

const callbackTimeoutMs = 15 * 60 * 1_000

export const loginOptions = z.object({
  linkLocal: z
    .boolean()
    .optional()
    .describe('Authorize the existing local root as an access key for a WebAuthn wallet'),
  noBrowser: z.boolean().optional().describe('Do not attempt to open a browser')
})

export const initOptions = z.object({
  force: z.boolean().optional().describe('Overwrite the local wallet for this network'),
  hardwareEncryption: z
    .boolean()
    .optional()
    .describe('Create a non-exportable hardware-backed root wallet')
})

export const importOptions = z.object({
  address: z.string().optional().describe('Import a discoverable wallet by address'),
  force: z.boolean().optional().describe('Overwrite the local wallet for this network'),
  privateKey: z.string().optional().describe('Import an exportable root private key')
})

export const listOptions = z.object({
  imported: z.boolean().optional().describe('Only show imported wallets'),
  walletType: z.enum(['hardware', 'local', 'passkey']).optional().describe('Filter wallet type')
})

export const logoutOptions = z.object({
  yes: z.boolean().optional().describe('Skip confirmation prompt')
})

type InitOptions = z.infer<typeof initOptions>
type ImportOptions = z.infer<typeof importOptions>
type ListOptions = z.infer<typeof listOptions>
type LoginOptions = z.infer<typeof loginOptions>
type LogoutOptions = z.infer<typeof logoutOptions>
type InitResult = {
  entry: KeyEntry
  hardwareEncryptionProvider?: string | undefined
  hardwareEncryptionStatus?: string | undefined
  secretStorageProvider: string
  secretStorageStatus: string
}

type WalletListItem = {
  address: string
  imported: boolean
  network: string
  storage: string
  wallet_type: 'hardware' | 'local' | 'passkey'
}

export async function login(network: Network, globals: GlobalOptions, options: LoginOptions) {
  return await loginImpl(network, globals, {
    forceReauth: false,
    linkLocal: options.linkLocal ?? false,
    noBrowser: options.noBrowser
  })
}

export async function init(network: Network, globals: GlobalOptions, options: InitOptions) {
  const keys = await loadKeystore()
  const existing = keyForNetwork(keys, network.chainId)
  if (existing && !options.force)
    throw new Error(
      `A wallet already exists for '${network.name}'. Use --force to replace it or run 'tempo wallet whoami'.`
    )

  const result = options.hardwareEncryption
    ? await createHardwareRootEntry(network)
    : await createExportableRootEntry(network)
  const entry = result.entry
  const walletAddress = normalizeAddress(entry.walletAddress)
  const storage = entry.keyStorage ?? 'file'

  await saveKeystore([...keys.filter(key => key.chainId !== network.chainId), entry])

  const response = {
    chain_id: network.chainId,
    exportable: entry.keyStorage !== 'secure-enclave',
    key_address: walletAddress,
    ...(entry.keyStorageHash ? { key_storage_hash: entry.keyStorageHash } : {}),
    ...(entry.keyStorageLabel ? { key_storage_label: entry.keyStorageLabel } : {}),
    ...(result.hardwareEncryptionProvider
      ? { hardware_encryption_provider: result.hardwareEncryptionProvider }
      : {}),
    ...(result.hardwareEncryptionStatus
      ? { hardware_encryption_status: result.hardwareEncryptionStatus }
      : {}),
    network: network.name,
    secret_storage_provider: result.secretStorageProvider,
    secret_storage_status: result.secretStorageStatus,
    storage,
    sync: result.hardwareEncryptionStatus
      ? hardwareSync(result.hardwareEncryptionStatus)
      : storageSync(storage),
    wallet: walletAddress,
    wallet_type: 'local'
  }
  if (!shouldRenderText(globals)) return response

  if (!globals.silent)
    process.stderr.write(
      options.hardwareEncryption
        ? 'Hardware-backed root wallet created.\n'
        : 'Local wallet created.\n'
    )
  process.stdout.write(`Wallet: ${walletAddress}\n`)
  process.stdout.write(`Network: ${network.name}\n`)
  process.stdout.write(`Storage: ${storage}\n`)
  process.stdout.write(
    `Secret storage: ${result.secretStorageProvider} (${result.secretStorageStatus})\n`
  )
  if (result.hardwareEncryptionProvider)
    process.stdout.write(
      `Hardware encryption: ${result.hardwareEncryptionProvider} (${result.hardwareEncryptionStatus})\n`
    )
  if (entry.keyStorage === 'secure-enclave') {
    process.stdout.write('Exportable: no\n')
    process.stdout.write('Sync: device_only\n')
    process.stdout.write(`Secure Enclave label: ${entry.keyStorageLabel}\n`)
    process.stdout.write(
      '\nThis root key is non-exportable and can only sign on this device.\n' +
        "For CLI automation, run 'tempo wallet keys create' to create a revocable local access key.\n"
    )
  } else if (result.hardwareEncryptionStatus === 'unsupported_noop') {
    process.stdout.write(
      '\nHardware-backed non-exportable roots are not implemented on this OS yet.\n' +
        'Created an exportable local root using the current fallback storage path.\n'
    )
  }
  process.stdout.write(`Keys: ${keysPath()}\n`)
  return undefined
}

export async function importWallet(
  network: Network,
  globals: GlobalOptions,
  options: ImportOptions
) {
  if (options.privateKey && options.address)
    throw new Error('Use either --private-key or --address, not both.')
  if (!options.privateKey && !options.address)
    throw new Error(
      'Use --private-key to import a raw key or --address to import a discoverable wallet.'
    )

  const keys = await loadKeystore()
  const entry = options.privateKey
    ? await importPrivateKey(network, options.privateKey)
    : await importDiscoverableAddress(network, options.address!)
  const entryNetwork = networkFromChainId(entry.chainId) ?? network
  const existing = keyForNetwork(keys, entry.chainId)
  if (
    existing &&
    !options.force &&
    normalizeAddress(existing.walletAddress) !== entry.walletAddress
  )
    throw new Error(
      `A wallet already exists for '${entryNetwork.name}'. Use --force to replace it or run 'tempo wallet whoami'.`
    )

  await saveKeystore([...keys.filter(key => key.chainId !== entry.chainId), entry])
  const response = {
    address: entry.walletAddress,
    chain_id: entry.chainId,
    imported: true,
    key_address: entry.keyAddress,
    network: entryNetwork.name,
    storage: storageForEntry(entry),
    wallet_type: walletTypeForEntry(entry)
  }
  if (!shouldRenderText(globals)) return response

  process.stdout.write(`Imported: ${response.address}\n`)
  process.stdout.write(`Network: ${displayNetworkName(entry.chainId)}\n`)
  process.stdout.write(`Storage: ${response.storage}\n`)
  process.stdout.write(`Type: ${response.wallet_type}\n`)
  return undefined
}

export async function listWallets(globals: GlobalOptions, options: ListOptions) {
  const keys = await loadKeystore()
  const selectedNetworks = globals.network
    ? [resolveNetworkForList(globals.network)]
    : Object.values(networks)
  const rows = filterWalletList(
    dedupeWalletList([
      ...keys.map(entryToWalletListItem),
      ...(await indexedWalletListItems(keys)),
      ...(await hardwareWalletListItems(keys, selectedNetworks))
    ]),
    options
  )
  const response = { total: rows.length, wallets: rows }
  if (!shouldRenderText(globals)) return response

  if (rows.length === 0) {
    process.stdout.write('No wallets found.\n')
    return undefined
  }
  process.stdout.write(
    `${pad('Address', 44)}  ${pad('Network', 8)}  ${pad('Type', 8)}  ${pad('Storage', 24)}  Imported\n`
  )
  for (const row of rows) {
    process.stdout.write(
      `${pad(row.address, 44)}  ${pad(row.network, 8)}  ${pad(row.wallet_type, 8)}  ${pad(row.storage, 24)}  ${row.imported ? 'yes' : 'no'}\n`
    )
  }
  return undefined
}

function hardwareSync(status: string) {
  return status === 'active' ? 'device_only' : 'local_file'
}

function storageSync(storage: string) {
  if (storage === 'secure-enclave') return 'device_only'
  if (storage === 'keychain') return 'keychain_default'
  return 'local_file'
}

async function createExportableRootEntry(network: Network): Promise<InitResult> {
  const secretStorage = platformSecretStorage()
  const privateKey = generatePrivateKey()
  const entry = await createPrivateKeyRootEntry(network, privateKey)
  return {
    entry,
    secretStorageProvider: secretStorage.provider,
    secretStorageStatus: entry.keyReference ? secretStorage.status : 'unsupported_noop'
  }
}

async function createPrivateKeyRootEntry(network: Network, privateKey: Hex.Hex): Promise<KeyEntry> {
  const secretStorage = platformSecretStorage()
  const account = Account.fromSecp256k1(privateKey)
  const walletAddress = normalizeAddress(account.address)
  const reference = keychainReference(network.chainId, walletAddress)
  const storedInKeychain = await storeKeychainSecret(reference, privateKey)
  if (storedInKeychain)
    await indexStoredWallet({
      address: walletAddress,
      chainId: network.chainId,
      provider: secretStorage.provider,
      reference,
      type: 'local'
    })
  return {
    chainId: network.chainId,
    ...(storedInKeychain
      ? { keyReference: reference, keyStorage: 'keychain' }
      : { key: privateKey }),
    keyAddress: walletAddress,
    keyType: 'secp256k1',
    limits: [],
    walletAddress,
    walletType: 'local'
  }
}

async function createHardwareRootEntry(network: Network): Promise<InitResult> {
  const hardwareStorage = platformHardwareStorage()
  if (hardwareStorage.status !== 'active') {
    const result = await createExportableRootEntry(network)
    return {
      ...result,
      hardwareEncryptionProvider: hardwareStorage.provider,
      hardwareEncryptionStatus: hardwareStorage.status
    }
  }

  const label = `tempo_wallet_${network.name}_${Date.now()}_p256_ne`
  const identity = await createSecureEnclaveIdentity(label)
  const walletAddress = normalizeAddress(identity.address)
  return {
    entry: {
      chainId: network.chainId,
      keyAddress: walletAddress,
      keyStorage: 'secure-enclave',
      keyStorageHash: identity.hash,
      keyStorageLabel: identity.label,
      keyType: 'p256',
      limits: [],
      walletAddress,
      walletType: 'local'
    },
    hardwareEncryptionProvider: hardwareStorage.provider,
    hardwareEncryptionStatus: hardwareStorage.status,
    secretStorageProvider: platformSecretStorage().provider,
    secretStorageStatus: 'not_used'
  }
}

async function importPrivateKey(network: Network, privateKeyInput: string) {
  const privateKey = hexSchema.parse(privateKeyInput)
  if (Hex.size(privateKey) !== 32) throw new Error('Expected a 32-byte private key.')
  return await createPrivateKeyRootEntry(network, privateKey)
}

async function importDiscoverableAddress(network: Network, addressInput: string) {
  const address = normalizeAddress(addressInput)
  const hardware = await listSecureEnclaveIdentities()
  const identity = hardware.find(identity => identity.address === address)
  if (identity) {
    return {
      chainId: network.chainId,
      keyAddress: address,
      keyStorage: 'secure-enclave',
      keyStorageHash: identity.hash,
      keyStorageLabel: identity.label,
      keyType: 'p256',
      limits: [],
      walletAddress: address,
      walletType: 'local'
    } satisfies KeyEntry
  }

  const indexedWallets = (await listStoredWalletIndex()).filter(item => item.address === address)
  const indexed = indexedWallets.find(item => item.chainId === network.chainId) ?? indexedWallets[0]
  if (indexed?.type === 'local') {
    const indexedNetwork = networkFromChainId(indexed.chainId) ?? network
    const privateKey = hexSchema.parse(await loadIndexedPrivateKey(indexed.reference))
    return await createPrivateKeyRootEntry(indexedNetwork, privateKey)
  }

  throw new Error(`No discoverable Tempo wallet found for address '${address}'.`)
}

async function loadIndexedPrivateKey(reference: string) {
  return await loadKeychainSecret(reference)
}

function entryToWalletListItem(entry: KeyEntry): WalletListItem {
  return {
    address: normalizeAddress(entry.walletAddress),
    imported: true,
    network: displayNetworkName(entry.chainId),
    storage: storageForEntry(entry),
    wallet_type: walletTypeForEntry(entry)
  }
}

async function indexedWalletListItems(keys: readonly KeyEntry[]) {
  return (await listStoredWalletIndex()).map(
    (item): WalletListItem => ({
      address: item.address,
      imported: keys.some(
        key => key.chainId === item.chainId && normalizeAddress(key.walletAddress) === item.address
      ),
      network: displayNetworkName(item.chainId),
      storage: item.provider,
      wallet_type: item.type === 'hardware' ? 'hardware' : 'local'
    })
  )
}

async function hardwareWalletListItems(
  keys: readonly KeyEntry[],
  selectedNetworks: readonly Network[]
) {
  const storage = platformHardwareStorage().provider
  return (await listSecureEnclaveIdentities()).flatMap(identity => {
    const labelNetwork = networkFromHardwareLabel(identity.label)
    const networks = labelNetwork ? [labelNetwork] : selectedNetworks
    return networks.map(
      (network): WalletListItem => ({
        address: identity.address,
        imported: keys.some(
          key =>
            key.chainId === network.chainId &&
            normalizeAddress(key.walletAddress) === identity.address &&
            key.keyStorage === 'secure-enclave'
        ),
        network: displayNetworkName(network.chainId),
        storage,
        wallet_type: 'hardware'
      })
    )
  })
}

function dedupeWalletList(rows: WalletListItem[]) {
  const map = new Map<string, WalletListItem>()
  for (const row of rows) {
    const key = `${row.address}:${row.network}:${row.wallet_type}:${row.storage}`
    const existing = map.get(key)
    map.set(key, existing ? { ...row, imported: existing.imported || row.imported } : row)
  }
  return [...map.values()].sort((a, b) =>
    `${a.network}:${a.wallet_type}:${a.address}`.localeCompare(
      `${b.network}:${b.wallet_type}:${b.address}`
    )
  )
}

function filterWalletList(rows: WalletListItem[], options: ListOptions) {
  return rows.filter(row => {
    if (options.walletType && row.wallet_type !== options.walletType) return false
    if (options.imported && !row.imported) return false
    return true
  })
}

function storageForEntry(entry: KeyEntry) {
  if (entry.keyStorage === 'secure-enclave') return platformHardwareStorage().provider
  if (entry.keyStorage === 'keychain') return platformSecretStorage().provider
  return 'local-file'
}

function walletTypeForEntry(entry: KeyEntry): WalletListItem['wallet_type'] {
  if (entry.keyStorage === 'secure-enclave') return 'hardware'
  if (entry.walletType === 'passkey') return 'passkey'
  return 'local'
}

function networkFromHardwareLabel(label: string) {
  if (label.startsWith('tempo_wallet_tempo-moderato_')) return networks['tempo-moderato']
  if (label.startsWith('tempo_wallet_tempo_')) return networks.tempo
  return undefined
}

function resolveNetworkForList(value: string) {
  if (value.trim().toLowerCase() === 'testnet') return networks['tempo-moderato']
  if (value.trim().toLowerCase() === 'moderato') return networks['tempo-moderato']
  if (value.trim().toLowerCase() === 'tempo-moderato') return networks['tempo-moderato']
  return networks.tempo
}

function displayNetworkName(chainId: number) {
  const network = networkFromChainId(chainId)
  if (network?.name === 'tempo') return 'mainnet'
  if (network?.name === 'tempo-moderato') return 'testnet'
  return String(chainId)
}

function pad(value: string, width: number) {
  return value.length >= width ? value : value.padEnd(width)
}

export async function refresh(network: Network, globals: GlobalOptions) {
  return await loginImpl(network, globals, { forceReauth: true, noBrowser: false })
}

export async function logout(globals: GlobalOptions, options: LogoutOptions) {
  const keys = await loadKeystore()
  const passkey = findPasskeyWallet(keys)

  if (!passkey) {
    const response = { logged_in: false, disconnected: false, message: 'not logged in' }
    if (!shouldRenderText(globals)) return response
    process.stderr.write('Not logged in.\n')
    return undefined
  }

  const wallet = normalizeAddress(passkey.walletAddress)
  if (!options.yes && !confirm(`Disconnect wallet ${shortAddress(wallet)}?`)) {
    const response = { logged_in: true, disconnected: false, wallet, message: 'cancelled' }
    if (!shouldRenderText(globals)) return response
    process.stderr.write('Cancelled.\n')
    return undefined
  }

  await saveKeystore(deletePasskeyWalletAddress(keys, wallet))
  const response = { logged_in: true, disconnected: true, wallet, message: 'wallet disconnected' }
  if (!shouldRenderText(globals)) return response
  process.stderr.write('Wallet disconnected.\n')
  return undefined
}

async function loginImpl(
  network: Network,
  globals: GlobalOptions,
  options: LoginOptions & { forceReauth: boolean }
) {
  const keys = await loadKeystore()
  const localRoot = options.linkLocal ? findLinkableLocalRoot(keys, network) : undefined
  const alreadyLoggedIn = localRoot ? false : hasKeyForNetwork(keys, network.chainId)

  if (options.forceReauth && alreadyLoggedIn) ensureRefreshSupported(keys, network)

  let staleBackup: KeyEntry[] | undefined
  if (options.forceReauth && alreadyLoggedIn) {
    const entry = keyForNetwork(keys, network.chainId)
    if (entry) {
      staleBackup = keys
      await saveKeystore(deletePasskeyWalletAddress(keys, entry.walletAddress))
      if (shouldRenderText(globals)) process.stderr.write('Refreshing access key...\n')
    }
  }

  if (!alreadyLoggedIn || options.forceReauth) {
    try {
      await doLogin(network, globals, options.noBrowser ?? false, localRoot)
    } catch (error) {
      if (staleBackup) {
        await saveKeystore(staleBackup)
        if (shouldRenderText(globals))
          process.stderr.write('Access key refresh failed. Restored previous access key.\n')
      }
      throw error
    }
  }

  if (shouldRenderText(globals) && !globals.silent) {
    if (options.forceReauth && alreadyLoggedIn) process.stderr.write('\nAccess key refreshed!\n\n')
    else if (alreadyLoggedIn) process.stderr.write('Already logged in.\n\n')
    else process.stderr.write('\nWallet connected!\n\n')
  }

  return await showWhoami(network, globals)
}

async function doLogin(
  network: Network,
  globals: GlobalOptions,
  noBrowser: boolean,
  localRoot?: KeyEntry  
) {
  const authServerUrl = globals.env.TEMPO_AUTH_URL ?? network.authUrl
  const authBaseUrl = resolveAuthBaseUrl(authServerUrl)
  const authUrl = new URL(authBaseUrl)

  const privateKey = localRoot ? undefined : generatePrivateKey()
  const account = localRoot
    ? await accountForLocalRoot(localRoot)
    : privateKeyToAccount(privateKey!)
  const { verifier, challenge } = createPkcePair()

  const code = await createDeviceCode(authBaseUrl, account.publicKey, challenge, network)
  const displayCode = formatVerificationCode(code)
  authUrl.searchParams.set('code', displayCode)
  const url = authUrl.toString()

  process.stderr.write(`Auth URL: ${url}\n`)
  const opened = tryOpenBrowser(url, noBrowser, globals.env)

  if (noBrowser) showRemoteLoginPrompt(url, code)
  else if (shouldRenderText(globals) && !globals.silent) showLoginPrompt(code)
  if (opened === 'failed') process.stderr.write(`Open this URL manually: ${url}\n`)

  const callback = await pollUntilAuthorized(authBaseUrl, displayCode, verifier, globals)
  await saveLoginKey(network, callback, privateKey, account.address, localRoot)
}

async function createDeviceCode(
  baseUrl: string,
  publicKey: Hex.Hex,
  codeChallenge: string,
  network: Network
) {
  const legacy = await postJson(`${baseUrl}/device-code`, {
    code_challenge: codeChallenge,
    key_type: 'secp256k1',
    pub_key: publicKey
  })

  const legacyJson = asRecord(legacy.json)
  if (legacy.ok && typeof legacyJson.code === 'string') return legacyJson.code
  if (legacy.ok && legacyJson.__nonJson !== true) throw httpError('request device code', legacy)
  if (!legacy.ok && legacy.status !== 404) throw httpError('request device code', legacy)

  const next = await postJson(`${baseUrl}/code`, {
    chainId: `0x${network.chainId.toString(16)}`,
    codeChallenge,
    keyType: 'secp256k1',
    pubKey: publicKey
  })
  const nextJson = asRecord(next.json)
  if (next.ok && typeof nextJson.code === 'string') return nextJson.code
  throw httpError('request device code', next)
}

async function pollUntilAuthorized(
  baseUrl: string,
  code: string,
  codeVerifier: string,
  globals: GlobalOptions
) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < callbackTimeoutMs) {
    const response = await postJson(`${baseUrl}/poll/${code}`, {
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

    await NodeTimers.setTimeout(
      Number.parseInt(globals.env.TEMPO_WALLET_POLL_INTERVAL_MS ?? '2000', 10)
    )
  }

  throw new Error('Login expired before authorization completed.')
}

async function saveLoginKey(
  network: Network,
  callback: { accountAddress: string; keyAuthorization: unknown },
  privateKey: Hex.Hex | undefined,
  keyAddress: string,
  localRoot?: KeyEntry  
) {
  const walletAddress = normalizeAddress(callback.accountAddress)
  const parsed = parseKeyAuthorization(callback.keyAuthorization, keyAddress)
  const entry: KeyEntry = {
    chainId: parsed?.chainId && parsed.chainId !== 0 ? parsed.chainId : network.chainId,
    ...(typeof parsed?.expiry === 'number' ? { expiry: parsed.expiry } : {}),
    ...(privateKey ? { key: privateKey } : {}),
    ...(localRoot?.key ? { key: localRoot.key } : {}),
    ...(localRoot?.keyReference ? { keyReference: localRoot.keyReference } : {}),
    keyAddress: normalizeAddress(keyAddress),
    ...(parsed?.hex ? { keyAuthorization: parsed.hex } : {}),
    keyType: parsed?.keyType ?? localRoot?.keyType ?? 'secp256k1',
    limits: parsed?.limits ?? [],
    walletAddress,
    walletType: 'passkey'
  }

  await saveKeystore(upsertKey(await loadKeystore(), entry), keysPath())
}

async function accountForLocalRoot(root: KeyEntry) {
  if (root.keyType !== 'secp256k1')
    throw new Error('Linking a local wallet to WebAuthn currently requires a secp256k1 local root.')
  const privateKey = (root.key ??
    (root.keyReference ? await loadKeychainSecret(root.keyReference) : undefined)) as
    | Hex.Hex
    | undefined
  if (!privateKey)
    throw new Error(
      'Linking a local wallet to WebAuthn currently requires an exportable local root key.'
    )
  return Account.fromSecp256k1(privateKey)
}

function findLinkableLocalRoot(keys: readonly KeyEntry[], network: Network) {
  const root = keys.find(key => {
    if (key.chainId !== network.chainId || key.walletType !== 'local') return false
    const wallet = normalizeAddress(key.walletAddress)
    const keyAddress = key.keyAddress ? normalizeAddress(key.keyAddress) : undefined
    return Boolean(keyAddress && wallet === keyAddress && (key.key || key.keyReference))
  })
  if (!root)
    throw new Error(
      `No exportable local root wallet found for '${network.name}'. Run 'tempo wallet init' first.`
    )
  return root
}

function parseKeyAuthorization(value: unknown, expectedKeyAddress: string) {
  if (value == null) return undefined

  const signed =
    typeof value === 'string'
      ? KeyAuthorization.deserialize(hexSchema.parse(value))
      : KeyAuthorization.fromRpc(keyAuthorizationRpcSchema.parse(value))
  assertSignedKeyAuthorization(signed)

  const keyAddress = normalizeAddress(signed.address)
  if (keyAddress !== normalizeAddress(expectedKeyAddress))
    throw new Error(`Invalid key authorization target: ${keyAddress}`)

  return {
    chainId: Number(signed.chainId),
    expiry: signed.expiry ?? 0,
    hex: typeof value === 'string' ? hexSchema.parse(value) : KeyAuthorization.serialize(signed),
    keyType: keyTypeToStored(signed.type),
    limits: signed.limits?.map(
      (limit): StoredTokenLimit => ({
        currency: normalizeAddress(limit.token),
        limit: String(limit.limit)
      })
    )
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

export function tryOpenBrowser(
  url: string,
  noBrowser: boolean,
  env: Pick<GlobalOptions['env'], 'TEMPO_WALLET_DISABLE_BROWSER_OPEN'> = {}
) {
  if (env.TEMPO_WALLET_DISABLE_BROWSER_OPEN === '1') return 'skipped'
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

function resolveAuthBaseUrl(authServerUrl: string) {
  const url = new URL(authServerUrl)
  url.hash = ''
  url.search = ''
  return url.toString().replace(/\/$/, '')
}

async function postJson(url: string, body: unknown) {
  try {
    const response = await fetch(url, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'POST'
    })
    const text = await response.text()
    const json = text ? parseJsonResponse(text) : {}
    return { json, ok: response.ok, status: response.status }
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error))
  }
}

function parseJsonResponse(text: string) {
  try {
    return JSON.parse(text)
  } catch {
    return { __nonJson: true, error: text }
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

const recordSchema = z.record(z.string(), z.unknown()).catch({})
const hexSchema = z.custom<Hex.Hex>(
  value => typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value)
)
const addressSchema = z.custom<Address.Address>(
  value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
)
const keyAuthorizationRpcShapeSchema = z.object({
  chainId: hexSchema,
  expiry: hexSchema.nullish(),
  keyId: addressSchema,
  keyType: z.enum(['secp256k1', 'p256', 'webAuthn']),
  signature: z.object({}).passthrough()
})
const keyAuthorizationRpcSchema = z.custom<KeyAuthorization.Rpc>(
  value => keyAuthorizationRpcShapeSchema.safeParse(value).success
)

function asRecord(value: unknown): Record<string, unknown> {
  return recordSchema.parse(value)
}

function assertSignedKeyAuthorization(
  auth: KeyAuthorization.KeyAuthorization
): asserts auth is KeyAuthorization.Signed {
  if (!auth.signature) throw new Error('Key authorization is missing a signature.')
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

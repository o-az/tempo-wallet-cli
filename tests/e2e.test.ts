/// <reference types="node" />

import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeHTTP from 'node:http'
import * as NodeFS from 'node:fs/promises'
import * as NodeChildProcess from 'node:child_process'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { saveKeystore, type KeyEntry } from '#keystore.ts'

type MockAuthServer = {
  close: () => Promise<void>
  pollCount: () => number
  url: string
}

type MockServer = {
  close: () => Promise<void>
  url: string
}

const wallet = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
const testnetToken = '0x20c0000000000000000000000000000000000000'
const privateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const recipient = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'

let server: MockAuthServer
let tempoHome: string

beforeEach(async () => {
  server = await startAuthServer()
  tempoHome = NodePath.join(
    await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'wallet-ts-')),
    '.tempo'
  )
})

afterEach(async () => {
  await server.close()
})

test('login persists a Rust-compatible passkey entry', async () => {
  const result = await runWallet(['--network', 'testnet', 'login', '--no-browser'])

  expect(result.exitCode).toBe(0)
  expect(result.stderr).toContain('Auth URL:')
  expect(result.stderr).toContain('Verification code: ABCD-EFGH')
  expect(result.stdout).toContain(`wallet: ${wallet}`)
  expect(server.pollCount()).toBeGreaterThanOrEqual(1)

  const keys = await readKeys()
  expect(keys).toContain('[[keys]]')
  expect(keys).toContain('wallet_type = "passkey"')
  expect(keys).toContain(`wallet_address = "${wallet}"`)
  expect(keys).toContain('chain_id = 42431')
  expect(keys).toContain('key_type = "secp256k1"')
  expect(keys).toContain('key_address = "0x')
  expect(keys).toContain('key = "0x')
})

test('login respects the configured wallet-next auth path', async () => {
  const result = await runWallet(['--network', 'testnet', 'login', '--no-browser'], {
    TEMPO_AUTH_URL: `${server.url}/api/auth/cli`
  })

  expect(result.exitCode).toBe(0)
  expect(result.stderr).toContain(`Auth URL: ${server.url}/api/auth/cli?code=ABCD-EFGH`)
  expect(await readKeys()).toContain(`wallet_address = "${wallet}"`)
  expect(server.pollCount()).toBeGreaterThanOrEqual(1)
})

test('init creates a local wallet without browser auth', async () => {
  const result = await runWallet(['--network', 'testnet', '-j', 'init'])

  expect(result.exitCode).toBe(0)
  const body = JSON.parse(result.stdout) as { wallet: string }
  expect(body.wallet).toMatch(/^0x[0-9a-f]{40}$/)
  expect(server.pollCount()).toBe(0)

  const keys = await readKeys()
  const address = body.wallet
  expect(address).toBeTruthy()
  expect(keys).toContain('[[keys]]')
  expect(keys).toContain('wallet_type = "local"')
  expect(keys).toContain(`wallet_address = "${address}"`)
  expect(keys).toContain(`key_address = "${address}"`)
  expect(keys).toContain('chain_id = 42431')
  expect(keys).toContain('key_type = "secp256k1"')
})

test('init refuses to overwrite an existing wallet unless forced', async () => {
  const first = await runWallet(['--network', 'testnet', '-j', 'init'])
  const second = await runWallet(['--network', 'testnet', 'init'])
  const forced = await runWallet(['--network', 'testnet', '-j', 'init', '--force'])

  expect(first.exitCode).toBe(0)
  expect(second.exitCode).toBe(1)
  expect(second.stderr || second.stdout).toContain('already exists')
  expect(forced.exitCode).toBe(0)
  expect(JSON.parse(forced.stdout)).toMatchObject({ wallet_type: 'local' })
})

test('import private key creates a local wallet and list reports imported wallets', async () => {
  const result = await runWallet([
    '--network',
    'testnet',
    '-j',
    'import',
    '--private-key',
    privateKey
  ])
  const list = await runWallet(['-j', 'list', '--imported'])

  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({
    address: wallet,
    chain_id: 42431,
    imported: true,
    network: 'tempo-moderato',
    wallet_type: 'local'
  })
  expect(JSON.parse(list.stdout)).toMatchObject({
    wallets: expect.arrayContaining([
      expect.objectContaining({
        address: wallet,
        imported: true,
        network: 'testnet',
        wallet_type: 'local'
      })
    ])
  })
})

test('import address restores a discoverable OS-secret-store wallet', async () => {
  if (process.platform !== 'darwin') return

  const first = await runWallet([
    '--network',
    'testnet',
    '-j',
    'import',
    '--private-key',
    privateKey
  ])
  await NodeFS.rm(keysPath())
  const second = await runWallet(['--network', 'testnet', '-j', 'import', '--address', wallet])

  expect(first.exitCode).toBe(0)
  expect(second.exitCode).toBe(0)
  expect(JSON.parse(second.stdout)).toMatchObject({
    address: wallet,
    chain_id: 42431,
    imported: true,
    network: 'tempo-moderato',
    wallet_type: 'local'
  })
  expect(await readKeys()).toContain(`wallet_address = "${wallet}"`)
})

test('whoami works immediately after headless init', async () => {
  const init = await runWallet(['--network', 'testnet', '-j', 'init'])
  const address = (JSON.parse(init.stdout) as { wallet: string }).wallet
  const whoami = await runWallet(['--network', 'testnet', '-j', 'whoami'])

  expect(whoami.exitCode).toBe(0)
  expect(JSON.parse(whoami.stdout)).toMatchObject({
    ready: true,
    wallet: address,
    key: {
      address,
      chain_id: 42431,
      network: 'tempo-moderato'
    }
  })
})

test('refresh replaces the current passkey entry', async () => {
  await expect(runWallet(['--network', 'testnet', 'login', '--no-browser'])).resolves.toMatchObject(
    {
      exitCode: 0
    }
  )
  const before = await readKeys()

  const result = await runWallet(['--network', 'testnet', 'refresh'])

  expect(result.exitCode).toBe(0)
  expect(result.stderr).toContain('Auth URL:')

  const after = await readKeys()
  expect(after).toContain(`wallet_address = "${wallet}"`)
  expect(after).not.toEqual(before)
})

test('logout removes passkey entries and reports structured output', async () => {
  await expect(runWallet(['--network', 'testnet', 'login', '--no-browser'])).resolves.toMatchObject(
    {
      exitCode: 0
    }
  )

  const result = await runWallet(['-j', 'logout', '--yes'])

  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({
    disconnected: true,
    logged_in: true,
    message: 'wallet disconnected',
    wallet
  })
  expect(await readKeys()).not.toContain('[[keys]]')
})

test('whoami reports unauthenticated state without a wallet', async () => {
  const text = await runWallet(['whoami'])
  const json = await runWallet(['-j', 'whoami'])

  expect(text.exitCode).toBe(0)
  expect(text.stdout).toBe('ready: false\n')
  expect(JSON.parse(json.stdout)).toEqual({ ready: false })
})

test('keys reports an empty keyring', async () => {
  const text = await runWallet(['keys'])
  const json = await runWallet(['-j', 'keys'])

  expect(text.exitCode).toBe(0)
  expect(text.stdout).toBe('keys[0]:\ntotal: 0\n')
  expect(JSON.parse(json.stdout)).toEqual({ keys: [], total: 0 })
})

test('whoami and keys report configured access key state', async () => {
  await seedKey()

  const whoami = await runWallet(['--network', 'testnet', '-j', 'whoami'])
  const keys = await runWallet(['--network', 'testnet', '-j', 'keys'])

  expect(whoami.exitCode).toBe(0)
  expect(JSON.parse(whoami.stdout)).toMatchObject({
    key: {
      address: wallet,
      chain_id: 42431,
      network: 'tempo-moderato',
      symbol: 'pathUSD',
      token: testnetToken
    },
    ready: true,
    wallet
  })

  expect(keys.exitCode).toBe(0)
  expect(JSON.parse(keys.stdout)).toMatchObject({
    keys: [
      {
        address: wallet,
        chain_id: 42431,
        key: privateKey,
        network: 'tempo-moderato',
        symbol: 'pathUSD',
        token: testnetToken,
        wallet_address: wallet,
        wallet_type: 'local'
      }
    ],
    total: 1
  })
})

test('transfer dry-run reports a transfer plan without submitting', async () => {
  await seedKey()

  const result = await runWallet([
    '--network',
    'testnet',
    '-j',
    'transfer',
    '1',
    testnetToken,
    `tempox${recipient.slice(2)}`,
    '--dry-run'
  ])

  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({
    amount: '1',
    chain_id: 42431,
    from: wallet,
    status: 'dry_run',
    symbol: 'pathUSD',
    to: recipient,
    token: testnetToken
  })
})

test('fund prints the auth funding URL and respects explicit address', async () => {
  const result = await runWallet(['fund', '--address', wallet, '--no-browser'], {
    TEMPO_WALLET_FUND_TIMEOUT_MS: '0'
  })

  expect(result.exitCode).toBe(0)
  expect(result.stderr).toContain(`Fund URL: ${server.url}/remote/rpc/wallet_deposit?`)
  expect(result.stderr).toContain(
    `Open this link on your device: ${server.url}/remote/rpc/wallet_deposit?`
  )
  const url = new URL(result.stderr.match(/Fund URL: (.+)/)?.[1] ?? '')
  expect(JSON.parse(url.searchParams.get('method') ?? 'null')).toBe('wallet_deposit')
  expect(JSON.parse(url.searchParams.get('params') ?? 'null')).toEqual([
    { address: wallet, chainId: 4217, displayName: 'Tempo CLI' }
  ])
  expect(JSON.parse(url.searchParams.get('_decoded') ?? 'null')).toEqual({
    method: 'wallet_deposit',
    params: [{ address: wallet, chainId: 4217, displayName: 'Tempo CLI' }]
  })
  expect(url.searchParams.has('testnet')).toBe(false)
})

test('fund marks wallet-next deposit links as testnet on testnet', async () => {
  const result = await runWallet(
    ['--network', 'testnet', 'fund', '--address', wallet, '--no-browser'],
    {
      TEMPO_WALLET_FUND_TIMEOUT_MS: '0'
    }
  )

  expect(result.exitCode).toBe(0)
  const url = new URL(result.stderr.match(/Fund URL: (.+)/)?.[1] ?? '')
  expect(url.searchParams.get('testnet')).toBe('true')
  expect(JSON.parse(url.searchParams.get('params') ?? 'null')).toEqual([
    { address: wallet, chainId: 42431, displayName: 'Tempo CLI' }
  ])
})

test('sessions list and sync report empty local session state', async () => {
  const list = await runWallet(['-j', 'sessions'])
  const sync = await runWallet(['-j', 'sessions', 'sync'])

  expect(list.exitCode).toBe(0)
  expect(JSON.parse(list.stdout)).toEqual({ sessions: [], total: 0 })
  expect(sync.exitCode).toBe(0)
  expect(JSON.parse(sync.stdout)).toEqual({ sessions: [], total: 0 })
})

test('sessions list renders local channel records', async () => {
  await seedSession()

  const result = await runWallet(['--network', 'testnet', '-j', 'sessions', 'list'])

  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({
    sessions: [
      {
        channel_id: '0x1234',
        deposit: '2',
        network: 'tempo-moderato',
        origin: 'https://api.example.com',
        remaining: '1.5',
        spent: '0.5',
        status: 'active',
        symbol: 'pathUSD'
      }
    ],
    total: 1
  })
})

test('sessions close dry-run and local close report selected channels', async () => {
  await seedKey()
  await seedSession()

  const dryRun = await runWallet([
    '--network',
    'testnet',
    '-j',
    'sessions',
    'close',
    '--all',
    '--dry-run'
  ])
  const close = await runWallet(['--network', 'testnet', '-j', 'sessions', 'close', '--all'])
  const list = await runWallet(['--network', 'testnet', '-j', 'sessions', 'list'])

  expect(dryRun.exitCode).toBe(0)
  expect(JSON.parse(dryRun.stdout)).toMatchObject({
    targets: [{ channel_id: '0x1234', origin: 'https://api.example.com', state: 'active' }]
  })
  expect(close.exitCode).toBe(0)
  expect(JSON.parse(close.stdout)).toMatchObject({
    closed: 1,
    failed: 0,
    pending: 0,
    results: [{ channel_id: '0x1234', origin: 'https://api.example.com', status: 'closed' }]
  })
  expect(JSON.parse(list.stdout)).toEqual({ sessions: [], total: 0 })
})

test('services list, search, and detail use the service directory', async () => {
  const services = await startServicesServer()
  try {
    const env = { TEMPO_SERVICES_URL: `${services.url}/services` }
    const list = await runWallet(['-j', 'services', 'list'], env)
    const search = await runWallet(['-j', 'services', '--search', 'weather'], env)
    const detail = await runWallet(['-j', 'services', 'openai'], env)

    expect(list.exitCode).toBe(0)
    expect(JSON.parse(list.stdout)).toMatchObject([
      { endpoint_count: 1, id: 'openai', name: 'OpenAI' },
      { endpoint_count: 0, id: 'weather', name: 'Weather' }
    ])
    expect(JSON.parse(search.stdout)).toMatchObject([{ id: 'weather' }])
    expect(JSON.parse(detail.stdout)).toMatchObject({
      endpoints: [{ method: 'POST', path: '/v1/chat' }],
      id: 'openai',
      name: 'OpenAI'
    })
  } finally {
    await services.close()
  }
})

test('help delegates to command help', async () => {
  const root = await runWallet(['help'])
  const transfer = await runWallet(['help', 'transfer'])

  expect(root.exitCode).toBe(0)
  expect(root.stdout).toContain('Wallet identity and custody operations')
  expect(transfer.exitCode).toBe(0)
  expect(transfer.stdout).toContain('wallet transfer — Transfer tokens to an address')
})

test('debug reports support info and honors network flag', async () => {
  const result = await runWallet(['--network', 'testnet', '--verbose', '-j', 'debug'])

  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({
    logged_in: false,
    network: 'tempo-moderato',
    request_version: '0.0.0',
    wallet_version: '0.0.0'
  })
})

test('silent suppresses non-essential fund progress output', async () => {
  const result = await runWallet(['--silent', 'fund', '--address', wallet, '--no-browser'], {
    TEMPO_WALLET_FUND_TIMEOUT_MS: '0'
  })

  expect(result.exitCode).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.stdout).toContain('status: timeout')
})

async function runWallet(args: readonly string[], env: Record<string, string> = {}) {
  return await runProcess('node', ['./src/index.ts', ...args], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      TEMPO_AUTH_URL: `${server.url}/cli-auth`,
      TEMPO_HOME: tempoHome,
      TEMPO_WALLET_DISABLE_BROWSER_OPEN: '1',
      TEMPO_WALLET_POLL_INTERVAL_MS: '1',
      ...env
    }
  })
}

async function readKeys() {
  return await NodeFS.readFile(keysPath(), 'utf8')
}

async function seedKey() {
  const entry: KeyEntry = {
    chainId: 42431,
    key: privateKey,
    keyAddress: wallet,
    keyType: 'secp256k1',
    limits: [{ currency: testnetToken, limit: '100000000' }],
    walletAddress: wallet,
    walletType: 'local'
  }
  await saveKeystore([entry], keysPath())
}

function keysPath() {
  return NodePath.join(tempoHome, 'wallet', 'keys.toml')
}

async function seedSession() {
  const path = NodePath.join(tempoHome, 'wallet', 'channels.db')
  await NodeFS.mkdir(NodePath.dirname(path), { recursive: true })
  const createSql = `
    CREATE TABLE channels (
      channel_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 1,
      origin TEXT NOT NULL,
      request_url TEXT NOT NULL DEFAULT '',
      chain_id INTEGER NOT NULL,
      escrow_contract TEXT NOT NULL,
      token TEXT NOT NULL,
      payee TEXT NOT NULL,
      payer TEXT NOT NULL,
      authorized_signer TEXT NOT NULL,
      salt TEXT NOT NULL,
      deposit TEXT NOT NULL,
      cumulative_amount TEXT NOT NULL,
      challenge_echo TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      close_requested_at INTEGER NOT NULL DEFAULT 0,
      grace_ready_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      accepted_cumulative TEXT NOT NULL DEFAULT '0',
      server_spent TEXT NOT NULL DEFAULT '0'
    )
  `
  const insertSql = `
    INSERT INTO channels (
      channel_id, origin, request_url, chain_id, escrow_contract, token, payee, payer,
      authorized_signer, salt, deposit, cumulative_amount, accepted_cumulative,
      challenge_echo, state, created_at, last_used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  const insertValues = [
    '0x1234',
    'https://api.example.com',
    'https://api.example.com/v1',
    42431,
    '0x0000000000000000000000000000000000000000',
    testnetToken,
    wallet,
    wallet,
    wallet,
    '0x00',
    '2000000',
    '500000',
    '500000',
    '{}',
    'active',
    1_700_000_000,
    1_700_000_100
  ]
  const script = [
    "import * as NodeSqlite from 'node:sqlite'",
    'const db = new NodeSqlite.DatabaseSync(process.env.CHANNEL_DB_PATH)',
    'try {',
    `db.exec(${JSON.stringify(createSql)})`,
    `db.prepare(${JSON.stringify(insertSql)}).run(...${JSON.stringify(insertValues)})`,
    '} finally {',
    '  db.close()',
    '}'
  ].join('\n')
  const { exitCode, stderr } = await runProcess('node', ['--input-type=module', '-e', script], {
    env: { ...process.env, CHANNEL_DB_PATH: path }
  })
  if (exitCode !== 0) throw new Error(stderr)
}

async function startAuthServer(): Promise<MockAuthServer> {
  let polls = 0
  const server = NodeHTTP.createServer(
    (request: NodeHTTP.IncomingMessage, response: NodeHTTP.ServerResponse) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'POST' && url.pathname === '/cli-auth/device-code') {
        sendJson(response, { code: 'ABCDEFGH' })
        return
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/cli/device-code') {
        sendHtml(response, '<!DOCTYPE html><html><body>Tempo Wallet</body></html>')
        return
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/cli/code') {
        sendJson(response, { code: 'ABCDEFGH' })
        return
      }

      if (
        request.method === 'POST' &&
        (url.pathname === '/cli-auth/poll/ABCDEFGH' || url.pathname === '/cli-auth/poll/ABCD-EFGH')
      ) {
        polls += 1
        if (polls % 2 === 1) {
          sendJson(response, { status: 'pending' })
          return
        }
        sendJson(response, {
          account_address: wallet,
          key_authorization: null,
          status: 'authorized'
        })
        return
      }

      if (
        request.method === 'POST' &&
        (url.pathname === '/api/auth/cli/poll/ABCDEFGH' ||
          url.pathname === '/api/auth/cli/poll/ABCD-EFGH')
      ) {
        polls += 1
        if (polls % 2 === 1) {
          sendJson(response, { status: 'pending' })
          return
        }
        sendJson(response, {
          accountAddress: wallet,
          keyAuthorization: null,
          status: 'authorized'
        })
        return
      }

      sendText(response, 'not found', 404)
    }
  )
  const url = await listen(server)

  return {
    close: () => closeServer(server),
    pollCount: () => polls,
    url
  }
}

async function startServicesServer(): Promise<MockServer> {
  const server = NodeHTTP.createServer(
    (request: NodeHTTP.IncomingMessage, response: NodeHTTP.ServerResponse) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/services') {
        sendText(response, 'not found', 404)
        return
      }
      sendJson(response, {
        services: [
          {
            categories: ['ai'],
            description: 'AI models',
            endpoints: [
              {
                method: 'POST',
                path: '/v1/chat',
                payment: { amount: '1000000', decimals: 6, intent: 'session' }
              }
            ],
            id: 'openai',
            name: 'OpenAI',
            serviceUrl: 'https://mpp.openai.example',
            tags: ['llm'],
            url: 'https://api.openai.example'
          },
          {
            categories: ['weather'],
            description: 'Weather data',
            endpoints: [],
            id: 'weather',
            name: 'Weather',
            serviceUrl: 'https://mpp.weather.example',
            tags: ['forecast'],
            url: 'https://api.weather.example'
          }
        ]
      })
    }
  )
  const url = await listen(server)

  return {
    close: () => closeServer(server),
    url
  }
}

async function runProcess(
  command: string,
  args: readonly string[],
  options: NodeChildProcess.SpawnOptions
) {
  const proc = NodeChildProcess.spawn(command, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(proc.stdout),
    readStream(proc.stderr),
    new Promise<number>(resolve => {
      proc.on('close', (code: number | null) => resolve(code ?? 1))
    })
  ])
  return { exitCode, stderr, stdout }
}

async function readStream(stream: NodeJS.ReadableStream | null) {
  if (!stream) return ''
  let result = ''
  for await (const chunk of stream) result += String(chunk)
  return result
}

async function listen(server: NodeHTTP.Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('HTTP server did not bind to a port')
  return `http://127.0.0.1:${address.port}`
}

async function closeServer(server: NodeHTTP.Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => (error ? reject(error) : resolve()))
  })
}

function sendJson(response: NodeHTTP.ServerResponse, body: unknown) {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function sendText(response: NodeHTTP.ServerResponse, body: string, status: number) {
  response.writeHead(status, { 'content-type': 'text/plain' })
  response.end(body)
}

function sendHtml(response: NodeHTTP.ServerResponse, body: string) {
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end(body)
}

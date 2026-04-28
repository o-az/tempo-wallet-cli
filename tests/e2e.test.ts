/// <reference types="bun" />

import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeFS from 'node:fs/promises'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { saveKeystore, type KeyEntry } from '#keystore.ts'

type MockAuthServer = {
  close: () => void
  pollCount: () => number
  url: string
}

const wallet = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
const testnetToken = '0x20c0000000000000000000000000000000000000'
const privateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const recipient = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'

let server: MockAuthServer
let tempoHome: string

beforeEach(async () => {
  server = startAuthServer()
  tempoHome = NodePath.join(
    await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'wallet-ts-')),
    '.tempo'
  )
})

afterEach(() => {
  server.close()
})

test('login persists a Rust-compatible passkey entry', async () => {
  const result = await runWallet(['--network', 'testnet', 'login', '--no-browser'])

  expect(result.exitCode).toBe(0)
  expect(result.stderr).toContain('Auth URL:')
  expect(result.stderr).toContain('Verification code: ABCD-EFGH')
  expect(result.stdout).toContain(`Wallet: ${wallet}`)
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

test('refresh replaces the current passkey entry', async () => {
  await expect(runWallet(['--network', 'testnet', 'login', '--no-browser'])).resolves.toMatchObject(
    {
      exitCode: 0
    }
  )
  const before = await readKeys()

  const result = await runWallet(['--network', 'testnet', 'refresh'])

  expect(result.exitCode).toBe(0)
  expect(result.stderr).toContain('Refreshing access key')
  expect(result.stderr).toContain('Access key refreshed')

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
  expect(text.stdout).toBe('Not logged in. Run `tempo wallet login` to get started.\n')
  expect(JSON.parse(json.stdout)).toEqual({ ready: false })
})

test('keys reports an empty keyring', async () => {
  const text = await runWallet(['keys'])
  const json = await runWallet(['-j', 'keys'])

  expect(text.exitCode).toBe(0)
  expect(text.stdout).toBe('No keys configured.\n')
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

async function runWallet(args: readonly string[]) {
  const proc = Bun.spawn(['bun', './src/index.ts', ...args], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      TEMPO_AUTH_URL: `${server.url}/cli-auth`,
      TEMPO_HOME: tempoHome,
      TEMPO_WALLET_DISABLE_BROWSER_OPEN: '1',
      TEMPO_WALLET_POLL_INTERVAL_MS: '1'
    },
    stderr: 'pipe',
    stdout: 'pipe'
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])
  return { exitCode, stderr, stdout }
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

function startAuthServer(): MockAuthServer {
  let polls = 0
  const server = Bun.serve({
    fetch(request: Request) {
      const url = new URL(request.url)
      if (request.method === 'POST' && url.pathname === '/cli-auth/device-code')
        return Response.json({ code: 'ABCDEFGH' })

      if (request.method === 'POST' && url.pathname === '/cli-auth/poll/ABCDEFGH') {
        polls += 1
        if (polls % 2 === 1) return Response.json({ status: 'pending' })
        return Response.json({
          account_address: wallet,
          key_authorization: null,
          status: 'authorized'
        })
      }

      return new Response('not found', { status: 404 })
    },
    port: 0
  })

  return {
    close: () => server.stop(true),
    pollCount: () => polls,
    url: `http://${server.hostname}:${server.port}`
  }
}

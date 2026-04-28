/// <reference types="bun" />

import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

type MockAuthServer = {
  close: () => void
  pollCount: () => number
  url: string
}

const wallet = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'

let server: MockAuthServer
let tempoHome: string

beforeEach(async () => {
  server = startAuthServer()
  tempoHome = join(await mkdtemp(join(tmpdir(), 'wallet-ts-')), '.tempo')
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
  return await readFile(join(tempoHome, 'wallet', 'keys.toml'), 'utf8')
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

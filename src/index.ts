import { Cli, z } from 'incur'

import {
  closeSessions,
  listSessions,
  syncSessions,
  sessionCloseArgs,
  sessionListOptions,
  sessionSyncOptions,
  sessionCloseOptions
} from '#sessions.ts'
import { debug } from '#debug.ts'
import { fund, fundOptions } from '#fund.ts'
import { resolveNetwork } from '#network.ts'
import { services, servicesArgs, servicesOptions } from '#services.ts'
import { init, login, initOptions, logout, refresh, logoutOptions, loginOptions } from '#auth.ts'
import { envSchema, globalOptionsSchema, type GlobalOptions } from '#output.ts'
import { keys, transfer, transferArgs, transferOptions, whoami } from '#wallet.ts'

const commandOutput = z.unknown()

const cli = Cli.create('wallet', {
  description: 'Wallet identity and custody operations',
  env: envSchema,
  outputPolicy: 'agent-only',
  version: '0.0.0'
})

cli.command('login', {
  description: 'Sign up or log in to your Tempo wallet',
  options: loginOptions,
  output: commandOutput,
  async run(c) {
    const globals = getGlobals(c)
    return await login(resolveNetwork(globals.network), globals, c.options)
  }
})

cli.command('init', {
  description: 'Create a local Tempo wallet without opening a browser',
  options: initOptions,
  output: commandOutput,
  async run(c) {
    const globals = getGlobals(c)
    return await init(resolveNetwork(globals.network), globals, c.options)
  }
})

cli.command('refresh', {
  description: 'Refresh your access key without logging out',
  output: commandOutput,
  async run(c) {
    const globals = getGlobals(c)
    return await refresh(resolveNetwork(globals.network), globals)
  }
})

cli.command('logout', {
  description: 'Log out and disconnect your wallet',
  options: logoutOptions,
  output: commandOutput,
  async run(c) {
    const globals = getGlobals(c)
    resolveNetwork(globals.network)
    return await logout(globals, c.options)
  }
})

cli.command('whoami', {
  description: 'Show who you are: wallet, balances, keys',
  output: commandOutput,
  async run(c) {
    const globals = getGlobals(c)
    return await whoami(resolveNetwork(globals.network), globals)
  }
})

cli.command('keys', {
  description: 'List keys and their spending limits',
  output: commandOutput,
  async run(c) {
    const globals = getGlobals(c)
    return await keys(resolveNetwork(globals.network), globals)
  }
})

cli.command('transfer', {
  description: 'Transfer tokens to an address',
  args: transferArgs,
  options: transferOptions,
  output: commandOutput,
  async run(c) {
    const globals = getGlobals(c)
    return await transfer(resolveNetwork(globals.network), globals, c)
  }
})

cli.command('fund', {
  description: 'Fund your wallet (testnet faucet or mainnet bridge)',
  options: fundOptions,
  output: commandOutput,
  async run(c) {
    const globals = getGlobals(c)
    return await fund(resolveNetwork(globals.network), globals, c.options)
  }
})

cli.command('funds', {
  description: 'Fund your wallet (testnet faucet or mainnet bridge)',
  options: fundOptions,
  output: commandOutput,
  async run(c) {
    const globals = getGlobals(c)
    return await fund(resolveNetwork(globals.network), globals, c.options)
  }
})

const sessionsCli = Cli.create('sessions', {
  description: 'Manage payment sessions',
  outputPolicy: 'agent-only'
})

sessionsCli.command('list', {
  description: 'List payment sessions',
  options: sessionListOptions,
  output: commandOutput,
  async run(c) {
    const globals = getGlobals(c)
    return await listSessions(resolveNetwork(globals.network), globals, c)
  }
})

sessionsCli.command('sync', {
  description: 'Sync local sessions with on-chain state',
  options: sessionSyncOptions,
  output: commandOutput,
  async run(c) {
    const globals = getGlobals(c)
    return await syncSessions(resolveNetwork(globals.network), globals, c)
  }
})

sessionsCli.command('close', {
  description: 'Close a payment session and remove it locally',
  args: sessionCloseArgs,
  options: sessionCloseOptions,
  output: commandOutput,
  async run(c) {
    const globals = getGlobals(c)
    return await closeSessions(resolveNetwork(globals.network), globals, c)
  }
})

cli.command(sessionsCli)

cli.command('services', {
  description: 'Browse the MPP service directory',
  args: servicesArgs,
  options: servicesOptions,
  output: commandOutput,
  async run(c) {
    return await services(getGlobals(c), c)
  }
})

cli.command('debug', {
  description: 'Collect debug info for support',
  output: commandOutput,
  async run(c) {
    const globals = getGlobals(c)
    return await debug(resolveNetwork(globals.network), globals)
  }
})

const globals = parseGlobalOptions(process.argv.slice(2))

await cli.serve(globals.argv)

export default cli

function getGlobals(c: { agent: boolean; format: string; formatExplicit: boolean }): GlobalOptions {
  return {
    ...globals.options,
    agent: c.agent,
    env: envSchema.parse(process.env),
    format: c.format,
    formatExplicit: c.formatExplicit
  }
}

function parseGlobalOptions(argv: string[]) {
  const next: string[] = []
  const options = globalOptionsSchema.parse({})

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (token === '-j' || token === '--json-output') {
      next.push('--format', 'json')
      continue
    }
    if (token === '-t' || token === '--toon-output') {
      next.push('--format', 'toon')
      continue
    }
    if (token === '-s' || token === '--silent') {
      options.silent = true
      continue
    }
    if (token === '-v' || token === '--verbose') {
      options.verbose += 1
      continue
    }
    if (token.startsWith('--verbose=')) {
      options.verbose += Number.parseInt(token.slice('--verbose='.length), 10) || 0
      continue
    }
    if (/^-v+$/.test(token) && token.length > 2) {
      options.verbose += token.length - 1
      continue
    }
    if (token === '-n' || token === '--network') {
      options.network = argv[++index]
      continue
    }
    if (token.startsWith('--network=')) {
      options.network = token.slice('--network='.length)
      continue
    }
    if (token === '--no-browser') {
      next.push('--noBrowser')
      continue
    }
    if (token === '--dry-run') {
      next.push('--dryRun')
      continue
    }
    if (token === '--fee-token') {
      next.push('--feeToken')
      continue
    }
    if (token.startsWith('--fee-token=')) {
      next.push(`--feeToken=${token.slice('--fee-token='.length)}`)
      continue
    }
    next.push(token)
  }

  return { argv: normalizeHelp(normalizeCommandDefaults(next)), options }
}

function normalizeCommandDefaults(argv: string[]) {
  const normalized: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    normalized.push(token)
    if (token !== 'sessions') continue
    const next = argv[index + 1]
    if (!next || (next.startsWith('-') && next !== '--help')) normalized.push('list')
  }
  return normalized
}

function normalizeHelp(argv: string[]) {
  if (argv[0] !== 'help') return argv
  const rest = argv.slice(1)
  return rest.length === 0 ? ['--help'] : [...rest, '--help']
}

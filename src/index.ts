import { Cli, z } from 'incur'

import { fund } from '#fund.ts'
import { debug } from '#debug.ts'
import { services } from '#services.ts'
import { resolveNetwork } from '#network.ts'
import type { GlobalOptions } from '#output.ts'
import { login, logout, refresh } from '#auth.ts'
import { keys, transfer, whoami } from '#wallet.ts'
import { closeSessions, listSessions, syncSessions } from '#sessions.ts'

const cli = Cli.create('wallet', {
  description: 'Wallet identity and custody operations',
  version: '0.0.0'
})

cli.command('login', {
  description: 'Sign up or log in to your Tempo wallet',
  options: z.object({
    noBrowser: z.boolean().optional().describe('Do not attempt to open a browser')
  }),
  async run(c) {
    const globals = getGlobals()
    await login(resolveNetwork(globals.network), globals, {
      noBrowser: c.options.noBrowser ?? false
    })
  }
})

cli.command('refresh', {
  description: 'Refresh your access key without logging out',
  async run() {
    const globals = getGlobals()
    await refresh(resolveNetwork(globals.network), globals)
  }
})

cli.command('logout', {
  description: 'Log out and disconnect your wallet',
  options: z.object({
    yes: z.boolean().optional().describe('Skip confirmation prompt')
  }),
  async run(c) {
    const globals = getGlobals()
    resolveNetwork(globals.network)
    await logout(globals, { yes: c.options.yes ?? false })
  }
})

cli.command('whoami', {
  description: 'Show who you are: wallet, balances, keys',
  async run() {
    const globals = getGlobals()
    await whoami(resolveNetwork(globals.network), globals)
  }
})

cli.command('keys', {
  description: 'List keys and their spending limits',
  async run() {
    const globals = getGlobals()
    await keys(resolveNetwork(globals.network), globals)
  }
})

cli.command('transfer', {
  description: 'Transfer tokens to an address',
  args: z.object({
    amount: z.string().describe('Amount in human units ("1.00", "50")'),
    token: z.string().describe('Token contract address (0x...)'),
    to: z.string().describe('Recipient address (0x...)')
  }),
  options: z.object({
    dryRun: z.boolean().optional().describe("Show plan + fee estimate, don't send"),
    feeToken: z.string().optional().describe('Pay fees in a different token (default: same token)')
  }),
  async run(c) {
    const globals = getGlobals()
    await transfer(resolveNetwork(globals.network), globals, {
      amount: c.args.amount,
      dryRun: c.options.dryRun ?? false,
      feeToken: c.options.feeToken,
      to: c.args.to,
      token: c.args.token
    })
  }
})

cli.command('fund', {
  description: 'Fund your wallet (testnet faucet or mainnet bridge)',
  options: z.object({
    address: z.string().optional().describe('Wallet address to fund (defaults to current wallet)'),
    noBrowser: z.boolean().optional().describe('Do not attempt to open a browser')
  }),
  async run(c) {
    const globals = getGlobals()
    await fund(resolveNetwork(globals.network), globals, {
      address: c.options.address,
      noBrowser: c.options.noBrowser ?? false
    })
  }
})

cli.command('funds', {
  description: 'Fund your wallet (testnet faucet or mainnet bridge)',
  options: z.object({
    address: z.string().optional().describe('Wallet address to fund (defaults to current wallet)'),
    noBrowser: z.boolean().optional().describe('Do not attempt to open a browser')
  }),
  async run(c) {
    const globals = getGlobals()
    await fund(resolveNetwork(globals.network), globals, {
      address: c.options.address,
      noBrowser: c.options.noBrowser ?? false
    })
  }
})

const sessionsCli = Cli.create('sessions', {
  description: 'Manage payment sessions'
})

sessionsCli.command('list', {
  description: 'List payment sessions',
  options: z.object({
    all: z
      .boolean()
      .optional()
      .describe('Include local sessions and on-chain orphaned discovery in one view'),
    orphaned: z
      .boolean()
      .optional()
      .describe('Include on-chain orphaned discovery and persist discovered channels locally')
  }),
  async run(c) {
    const globals = getGlobals()
    await listSessions(resolveNetwork(globals.network), globals, {
      all: c.options.all ?? false,
      orphaned: c.options.orphaned ?? false
    })
  }
})

sessionsCli.command('sync', {
  description: 'Sync local sessions with on-chain state',
  options: z.object({
    origin: z.string().optional().describe("Re-sync a specific origin's close state from on-chain")
  }),
  async run(c) {
    const globals = getGlobals()
    await syncSessions(resolveNetwork(globals.network), globals, {
      origin: c.options.origin
    })
  }
})

sessionsCli.command('close', {
  description: 'Close a payment session and remove it locally',
  args: z.object({
    url: z.string().optional().describe('URL, origin, or channel ID (0x...) to close')
  }),
  options: z.object({
    all: z.boolean().optional().describe('Close all active sessions and on-chain channels'),
    dryRun: z.boolean().optional().describe('Show what would be closed without executing'),
    finalize: z
      .boolean()
      .optional()
      .describe('Finalize channels pending close (grace period elapsed)'),
    orphaned: z
      .boolean()
      .optional()
      .describe('Close only orphaned on-chain channels (no local session)'),
    cooperative: z
      .boolean()
      .optional()
      .describe('Use cooperative close only (no on-chain fallback)')
  }),
  async run(c) {
    const globals = getGlobals()
    await closeSessions(resolveNetwork(globals.network), globals, {
      all: c.options.all ?? false,
      url: c.args.url,
      dryRun: c.options.dryRun ?? false,
      orphaned: c.options.orphaned ?? false,
      finalize: c.options.finalize ?? false,
      cooperative: c.options.cooperative ?? false
    })
  }
})

cli.command(sessionsCli)

cli.command('services', {
  description: 'Browse the MPP service directory',
  args: z.object({
    serviceId: z.string().optional().describe('Service ID to show details for')
  }),
  options: z.object({
    search: z.string().optional().describe('Search by name, description, tags, or category')
  }),
  async run(c) {
    await services(getGlobals(), {
      search: c.options.search,
      serviceId: c.args.serviceId
    })
  }
})

cli.command('debug', {
  description: 'Collect debug info for support',
  async run() {
    const globals = getGlobals()
    await debug(resolveNetwork(globals.network), globals)
  }
})

const globals = parseGlobalOptions(process.argv.slice(2))

try {
  await cli.serve(globals.argv)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}

function getGlobals(): GlobalOptions {
  return globals.options
}

function parseGlobalOptions(argv: string[]) {
  const next: string[] = []
  const options: GlobalOptions = {
    format: 'text',
    silent: false,
    verbose: 0
  }

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (token === '-j' || token === '--json-output') {
      options.format = 'json'
      continue
    }
    if (token === '-t' || token === '--toon-output') {
      options.format = 'toon'
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
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    normalized.push(token)
    if (token !== 'sessions') continue
    const next = argv[i + 1]
    if (!next || (next.startsWith('-') && next !== '--help')) normalized.push('list')
  }
  return normalized
}

function normalizeHelp(argv: string[]) {
  if (argv[0] !== 'help') return argv
  const rest = argv.slice(1)
  return rest.length === 0 ? ['--help'] : [...rest, '--help']
}

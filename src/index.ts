import { Cli, z } from 'incur'

import { resolveNetwork } from '#network.ts'
import type { GlobalOptions } from '#output.ts'
import { login, logout, refresh } from '#auth.ts'
import { keys, transfer, whoami } from '#wallet.ts'

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

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
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
    if (/^-v+$/.test(token) && token.length > 2) {
      options.verbose += token.length - 1
      continue
    }
    if (token === '-n' || token === '--network') {
      options.network = argv[++i]
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

  return { argv: next, options }
}

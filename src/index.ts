import { Cli, z } from 'incur'

import { resolveNetwork } from '#network.ts'
import type { GlobalOptions } from '#output.ts'
import { login, logout, refresh } from '#auth.ts'

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
    next.push(token)
  }

  return { argv: next, options }
}

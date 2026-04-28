import { z } from 'incur'
import * as NodeTimers from 'node:timers/promises'
import { createPublicClient, http, parseAbi } from 'viem'

import { tryOpenBrowser } from '#auth.ts'
import type { Network } from '#network.ts'
import { shouldRenderText, type GlobalOptions } from '#output.ts'
import { loadKeystore, keyForNetwork, normalizeAddress } from '#keystore.ts'
import { formatUnits, chainForNetwork, type ResolvedToken } from '#wallet.ts'

const tip20Abi = parseAbi(['function balanceOf(address account) view returns (uint256)'])

export const fundOptions = z.object({
  address: z.string().optional().describe('Wallet address to fund (defaults to current wallet)'),
  noBrowser: z.boolean().optional().describe('Do not attempt to open a browser')
})

type FundOptions = z.infer<typeof fundOptions>

export async function fund(network: Network, globals: GlobalOptions, options: FundOptions) {
  const address = await resolveAddress(network, options.address)
  const fundUrl = fundingUrl(network, globals)

  if ((shouldRenderText(globals) || options.noBrowser) && !globals.silent)
    process.stderr.write(`Fund URL: ${fundUrl}\n`)
  const opened = tryOpenBrowser(fundUrl, options.noBrowser ?? false, globals.env)
  if (options.noBrowser && !globals.silent) {
    process.stderr.write(`Open this link on your device: ${fundUrl}\n`)
    process.stderr.write('After funding is complete, return here to continue.\n')
  }
  if (opened === 'failed' && !globals.silent)
    process.stderr.write(`Open this URL manually: ${fundUrl}\n`)

  if ((shouldRenderText(globals) || options.noBrowser) && !globals.silent)
    process.stderr.write('Waiting for funding...\n')

  const callbackTimeoutMs = Number.parseInt(
    globals.env.TEMPO_WALLET_FUND_TIMEOUT_MS ?? '900000',
    10
  )
  if (callbackTimeoutMs <= 0) {
    if (!globals.silent) process.stderr.write('Timed out waiting for funding after 0 minutes.\n')
    return { address, fund_url: fundUrl, status: 'timeout' }
  }

  const pollIntervalMs = Number.parseInt(
    globals.env.TEMPO_WALLET_FUND_POLL_INTERVAL_MS ?? '3000',
    10
  )
  const before = await queryDefaultBalance(network, address).catch(() => undefined)
  const startedAt = Date.now()
  while (Date.now() - startedAt < callbackTimeoutMs) {
    await NodeTimers.setTimeout(pollIntervalMs)
    const current = await queryDefaultBalance(network, address).catch(() => undefined)
    if (current !== undefined && current !== before) {
      if (!globals.silent) {
        process.stderr.write('\nFunding received!\n')
        process.stderr.write(`  ${network.token.symbol} balance: ${before ?? '0'} -> ${current}\n`)
      }
      return { address, fund_url: fundUrl, status: 'funded' }
    }
  }

  if (!globals.silent)
    process.stderr.write(
      `Timed out waiting for funding after ${Math.floor(callbackTimeoutMs / 60000)} minutes.\n`
    )
  return { address, fund_url: fundUrl, status: 'timeout' }
}

async function resolveAddress(network: Network, input: string | undefined) {
  if (input) return normalizeAddress(input)
  const key = keyForNetwork(await loadKeystore(), network.chainId)
  if (!key) throw new Error("No wallet configured. Run 'tempo wallet login'.")
  return normalizeAddress(key.walletAddress)
}

function fundingUrl(network: Network, globals: GlobalOptions) {
  const authServerUrl = globals.env.TEMPO_AUTH_URL ?? network.authUrl
  const url = new URL(authServerUrl)
  return `${url.origin}/?action=fund`
}

async function queryDefaultBalance(network: Network, wallet: ResolvedToken['address']) {
  const token: ResolvedToken = network.token
  const balance = await createPublicClient({
    chain: chainForNetwork(network),
    transport: http(network.rpcUrl)
  }).readContract({
    abi: tip20Abi,
    address: token.address,
    args: [wallet],
    functionName: 'balanceOf'
  })
  return formatUnits(balance, token.decimals)
}

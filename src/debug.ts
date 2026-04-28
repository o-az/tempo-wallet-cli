import * as NodeOS from 'node:os'

import { showWhoami } from '#wallet.ts'
import type { Network } from '#network.ts'
import { shouldRenderText, type GlobalOptions } from '#output.ts'
import { loadKeystore, hasWallet, keyForNetwork, normalizeAddress } from '#keystore.ts'

import PackageJSON from '#package.json' with { type: 'json' }

type DebugInfo = {
  wallet_version: string
  request_version: string
  os: string
  arch: string
  network: string
  wallet?: string | undefined
  wallet_type?: string | undefined
  logged_in: boolean
}

export async function debug(network: Network, globals: GlobalOptions) {
  const keys = await loadKeystore()
  const key = keyForNetwork(keys, network.chainId)
  const loggedIn = hasWallet(keys)
  const info: DebugInfo = {
    wallet_version: PackageJSON.version,
    request_version: PackageJSON.version,
    os: NodeOS.platform(),
    arch: NodeOS.arch(),
    network: network.name,
    ...(loggedIn && key?.walletAddress ? { wallet: normalizeAddress(key.walletAddress) } : {}),
    ...(loggedIn && key?.walletType ? { wallet_type: key.walletType } : {}),
    logged_in: loggedIn
  }

  if (!shouldRenderText(globals)) return info

  process.stdout.write(renderDebugText(info))
  if (loggedIn) {
    process.stdout.write('\nwallet and access key\n=====================\n')
    await showWhoami(network, globals)
  }
  process.stdout.write('\nCopy the above and share it with Tempo support.\n')
  return undefined
}

function renderDebugText(info: DebugInfo) {
  const lines = [
    'tempo debug',
    '===========',
    '',
    `  tempo wallet  : ${info.wallet_version}`,
    `  tempo request : ${info.request_version}`,
    `  os            : ${info.os} (${info.arch})`,
    `  network       : ${info.network}`,
    ''
  ]

  if (info.logged_in) {
    lines.push(`  wallet        : ${info.wallet ?? '-'}`)
    lines.push(`  wallet type   : ${info.wallet_type ?? '-'}`)
  } else {
    lines.push('  wallet        : not logged in')
  }

  return `${lines.join('\n')}\n`
}

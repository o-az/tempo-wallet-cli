import * as NodePath from 'node:path'
import * as BunSqlite from 'bun:sqlite'

import { formatUnits } from '#wallet.ts'
import type { Network } from '#network.ts'
import { emit, type GlobalOptions } from '#output.ts'
import { hasWallet, keysPath, loadKeystore } from '#keystore.ts'

type ChannelRecord = {
  accepted_cumulative: string
  channel_id: string
  chain_id: number
  close_requested_at: number
  created_at: number
  cumulative_amount: string
  deposit: string
  grace_ready_at: number
  last_used_at: number
  origin: string
  state: string
}

type SessionItem = {
  channel_id: string
  network: string
  origin?: string | undefined
  symbol: string
  deposit: string
  spent: string
  remaining: string
  status: string
  remaining_secs?: number | undefined
  created_at?: string | undefined
  last_used_at?: string | undefined
}

export async function listSessions(
  network: Network,
  globals: GlobalOptions,
  options: { all: boolean; orphaned: boolean }
) {
  if (options.all || options.orphaned)
    throw new Error('On-chain orphaned session discovery is not implemented yet.')
  const sessions = loadChannelRecords()
    .filter(record => record.chain_id === network.chainId)
    .map(record => sessionItem(network, record))
    .filter(item => item.status !== 'finalized')

  renderSessions(globals, sessions, 'No sessions found.', 'session(s) total')
}

export async function syncSessions(
  network: Network,
  globals: GlobalOptions,
  options: { origin?: string | undefined }
) {
  const sessions = loadChannelRecords()
    .filter(record => record.chain_id === network.chainId)
    .filter(
      record =>
        !options.origin || normalizeOrigin(record.origin) === normalizeOrigin(options.origin)
    )
    .map(record => sessionItem(network, record))
    .filter(item => item.status !== 'finalized')

  renderSessions(globals, sessions, 'No sessions found.', 'session(s) total')
}

export async function closeSessions(
  network: Network,
  globals: GlobalOptions,
  options: {
    all: boolean
    url?: string | undefined
    dryRun: boolean
    orphaned: boolean
    finalize: boolean
    cooperative: boolean
  }
) {
  if (options.cooperative && (options.all || options.orphaned || options.finalize))
    throw new Error('--cooperative cannot be combined with --all, --orphaned, or --finalize.')
  if (options.dryRun && !options.url && !options.all && !options.orphaned && !options.finalize)
    throw new Error('Provide a session URL/channel id, --all, --orphaned, or --finalize.')
  if (!hasWallet(await loadKeystore()))
    throw new Error("No wallet configured. Log in with 'tempo wallet login'.")
  if (options.orphaned) throw new Error('On-chain orphaned session close is not implemented yet.')

  const records = selectCloseTargets(network, options)
  if (options.dryRun) return renderDryRun(globals, records, options.url)

  deleteChannels(records.map(record => record.channel_id))
  renderCloseSummary(globals, records)
}

function loadChannelRecords(): ChannelRecord[] {
  try {
    const db = new BunSqlite.Database(channelDbPath(), { create: false, readonly: true })
    try {
      return db
        .query<ChannelRecord, []>(`
        SELECT channel_id, chain_id, origin, deposit, cumulative_amount, accepted_cumulative,
               state, close_requested_at, grace_ready_at, created_at, last_used_at
        FROM channels
        ORDER BY last_used_at DESC
      `)
        .all()
    } finally {
      db.close()
    }
  } catch (error) {
    if ((error as Error).message.includes('unable to open database file')) return []
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    return []
  }
}

function selectCloseTargets(
  network: Network,
  options: { all: boolean; url?: string | undefined; finalize: boolean }
) {
  const records = loadChannelRecords().filter(record => record.chain_id === network.chainId)
  if (options.finalize) return records.filter(record => statusAt(record).status === 'finalizable')
  if (options.all) return records.filter(record => statusAt(record).status !== 'finalized')
  if (!options.url)
    throw new Error('Provide a session URL/channel id, --all, --orphaned, or --finalize.')
  if (options.url.toLowerCase().startsWith('0x'))
    return records.filter(record => record.channel_id.toLowerCase() === options.url!.toLowerCase())
  const origin = normalizeOrigin(options.url)
  return records.filter(record => normalizeOrigin(record.origin) === origin)
}

function sessionItem(network: Network, record: ChannelRecord): SessionItem {
  const deposit = parseAmount(record.deposit)
  const spent = acceptedAmount(record)
  const remaining = deposit > spent ? deposit - spent : 0n
  const { remainingSecs, status } = statusAt(record)

  return {
    channel_id: record.channel_id.toLowerCase(),
    network: network.name,
    ...(record.origin ? { origin: record.origin } : {}),
    symbol: network.token.symbol,
    deposit: formatUnits(deposit, network.token.decimals),
    spent: formatUnits(spent, network.token.decimals),
    remaining: formatUnits(remaining, network.token.decimals),
    status,
    ...(remainingSecs !== undefined ? { remaining_secs: remainingSecs } : {}),
    ...(record.created_at > 0 ? { created_at: formatTimestamp(record.created_at) } : {}),
    ...(record.last_used_at > 0 ? { last_used_at: formatTimestamp(record.last_used_at) } : {})
  }
}

function renderSessions(
  globals: GlobalOptions,
  sessions: SessionItem[],
  emptyMessage: string,
  countLabel: string
) {
  const response = { sessions, total: sessions.length }
  if (globals.format !== 'text') return emit(globals.format, response, () => undefined)
  if (sessions.length === 0) {
    process.stdout.write(`${emptyMessage}\n`)
    return
  }
  for (const session of sessions) renderSessionText(session)
  process.stdout.write(`${sessions.length} ${countLabel}.\n`)
}

function renderDryRun(
  globals: GlobalOptions,
  records: ChannelRecord[],
  target: string | undefined
) {
  const targets =
    records.length > 0
      ? records.map(record => ({
          channel_id: record.channel_id.toLowerCase(),
          origin: record.origin || undefined,
          state: record.state
        }))
      : target && !target.toLowerCase().startsWith('0x')
        ? [{ channel_id: '', origin: target, state: 'not found' }]
        : []
  const response = { targets }
  if (globals.format !== 'text') return emit(globals.format, response, () => undefined)
  if (globals.silent) return
  process.stderr.write(`[DRY RUN] Would close ${targets.length} session(s)\n`)
  for (const target of targets) {
    process.stderr.write(
      `  ${target.origin ? `${target.origin} (${target.channel_id})` : target.channel_id}\n`
    )
  }
}

function renderCloseSummary(globals: GlobalOptions, records: ChannelRecord[]) {
  const results = records.map(record => ({
    channel_id: record.channel_id.toLowerCase(),
    status: 'closed',
    ...(record.origin ? { origin: record.origin } : {})
  }))
  const response = { closed: results.length, failed: 0, pending: 0, results }
  if (globals.format !== 'text') return emit(globals.format, response, () => undefined)
  if (globals.silent) return
  process.stdout.write(
    results.length === 0 ? 'No channel to close.\n' : `${results.length} closed\n`
  )
}

function renderSessionText(session: SessionItem) {
  process.stdout.write(`${session.origin ?? session.channel_id}\n`)
  process.stdout.write(field('Network', session.network))
  if (session.origin) process.stdout.write(field('Channel', session.channel_id))
  process.stdout.write(field('Deposit', `${session.deposit} ${session.symbol}`))
  process.stdout.write(field('Spent', `${session.spent} ${session.symbol}`))
  process.stdout.write(field('Remaining', `${session.remaining} ${session.symbol}`))
  if (session.created_at) process.stdout.write(field('Created', session.created_at))
  if (session.last_used_at) process.stdout.write(field('Last used', session.last_used_at))
  process.stdout.write(field('Status', session.status))
  process.stdout.write('\n')
}

function acceptedAmount(record: ChannelRecord) {
  const accepted = parseAmount(record.accepted_cumulative)
  return accepted > 0n ? accepted : parseAmount(record.cumulative_amount)
}

function channelDbPath() {
  return NodePath.join(NodePath.dirname(keysPath()), 'channels.db')
}

function deleteChannels(channelIds: string[]) {
  if (channelIds.length === 0) return
  const db = new BunSqlite.Database(channelDbPath())
  try {
    const deleteChannel = db.query('DELETE FROM channels WHERE LOWER(channel_id) = LOWER(?)')
    for (const channelId of channelIds) deleteChannel.run(channelId)
  } finally {
    db.close()
  }
}

function field(label: string, value: string) {
  return `${label.padStart(10)}: ${value}\n`
}

function formatTimestamp(secs: number) {
  return new Date(secs * 1000).toISOString()
}

function normalizeOrigin(origin: string | undefined) {
  if (!origin) return ''
  try {
    const url = new URL(origin)
    return url.origin
  } catch {
    return origin.replace(/\/+$/, '')
  }
}

function parseAmount(value: string) {
  try {
    return BigInt(value)
  } catch {
    return 0n
  }
}

function statusAt(record: ChannelRecord) {
  const state = record.state.toLowerCase()
  if (state === 'closing') {
    const remaining = Math.max(0, record.grace_ready_at - Math.floor(Date.now() / 1000))
    return remaining === 0 && record.grace_ready_at > 0
      ? { remainingSecs: 0, status: 'finalizable' }
      : { remainingSecs: remaining, status: 'closing' }
  }
  return { status: state }
}

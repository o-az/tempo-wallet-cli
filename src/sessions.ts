import { z } from 'incur'
import * as NodePath from 'node:path'
import * as NodeSqlite from 'node:sqlite'

import { formatUnits } from '#wallet.ts'
import type { Network } from '#network.ts'
import { hasWallet, keysPath, loadKeystore } from '#keystore.ts'
import { shouldRenderText, type GlobalOptions } from '#output.ts'

const channelRecordSchema = z.object({
  accepted_cumulative: z.string(),
  channel_id: z.string(),
  chain_id: z.number(),
  close_requested_at: z.number(),
  created_at: z.number(),
  cumulative_amount: z.string(),
  deposit: z.string(),
  grace_ready_at: z.number(),
  last_used_at: z.number(),
  origin: z.string(),
  state: z.string()
})

const channelRecordsSchema = z.array(channelRecordSchema)

type ChannelRecord = z.infer<typeof channelRecordSchema>

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

export const sessionListOptions = z.object({
  all: z
    .boolean()
    .optional()
    .describe('Include local sessions and on-chain orphaned discovery in one view'),
  orphaned: z
    .boolean()
    .optional()
    .describe('Include on-chain orphaned discovery and persist discovered channels locally')
})

export const sessionSyncOptions = z.object({
  origin: z.string().optional().describe("Re-sync a specific origin's close state from on-chain")
})

export const sessionCloseArgs = z.object({
  url: z.string().optional().describe('URL, origin, or channel ID (0x...) to close')
})

export const sessionCloseOptions = z.object({
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
  cooperative: z.boolean().optional().describe('Use cooperative close only (no on-chain fallback)')
})

type SessionListContext = {
  options: z.infer<typeof sessionListOptions>
}

type SessionSyncContext = {
  options: z.infer<typeof sessionSyncOptions>
}

type SessionCloseContext = {
  args: z.infer<typeof sessionCloseArgs>
  options: z.infer<typeof sessionCloseOptions>
}

export async function listSessions(
  network: Network,
  globals: GlobalOptions,
  c: SessionListContext
) {
  if (c.options.all || c.options.orphaned)
    throw new Error('On-chain orphaned session discovery is not implemented yet.')
  const sessions = loadChannelRecords()
    .filter(record => record.chain_id === network.chainId)
    .map(record => sessionItem(network, record))
    .filter(item => item.status !== 'finalized')

  return renderSessions(globals, sessions, 'No sessions found.', 'session(s) total')
}

export async function syncSessions(
  network: Network,
  globals: GlobalOptions,
  c: SessionSyncContext
) {
  const sessions = loadChannelRecords()
    .filter(record => record.chain_id === network.chainId)
    .filter(
      record =>
        !c.options.origin || normalizeOrigin(record.origin) === normalizeOrigin(c.options.origin)
    )
    .map(record => sessionItem(network, record))
    .filter(item => item.status !== 'finalized')

  return renderSessions(globals, sessions, 'No sessions found.', 'session(s) total')
}

export async function closeSessions(
  network: Network,
  globals: GlobalOptions,
  c: SessionCloseContext
) {
  if (c.options.cooperative && (c.options.all || c.options.orphaned || c.options.finalize))
    throw new Error('--cooperative cannot be combined with --all, --orphaned, or --finalize.')
  if (
    c.options.dryRun &&
    !c.args.url &&
    !c.options.all &&
    !c.options.orphaned &&
    !c.options.finalize
  )
    throw new Error('Provide a session URL/channel id, --all, --orphaned, or --finalize.')
  if (!hasWallet(await loadKeystore()))
    throw new Error("No wallet configured. Log in with 'tempo wallet login'.")
  if (c.options.orphaned) throw new Error('On-chain orphaned session close is not implemented yet.')

  const records = selectCloseTargets(network, c)
  if (c.options.dryRun) return renderDryRun(globals, records, c.args.url)

  deleteChannels(records.map(record => record.channel_id))
  return renderCloseSummary(globals, records)
}

function loadChannelRecords(): ChannelRecord[] {
  try {
    const db = new NodeSqlite.DatabaseSync(channelDbPath(), { readOnly: true })
    try {
      const rows = db
        .prepare(`
        SELECT channel_id, chain_id, origin, deposit, cumulative_amount, accepted_cumulative,
               state, close_requested_at, grace_ready_at, created_at, last_used_at
        FROM channels
        ORDER BY last_used_at DESC
      `)
        .all()
      return channelRecordsSchema.parse(rows)
    } finally {
      db.close()
    }
  } catch (error) {
    if (errorMessage(error).includes('unable to open database file')) return []
    if (errorCode(error) === 'ENOENT') return []
    return []
  }
}

function selectCloseTargets(network: Network, c: SessionCloseContext) {
  const records = loadChannelRecords().filter(record => record.chain_id === network.chainId)
  if (c.options.finalize) return records.filter(record => statusAt(record).status === 'finalizable')
  if (c.options.all) return records.filter(record => statusAt(record).status !== 'finalized')
  if (!c.args.url)
    throw new Error('Provide a session URL/channel id, --all, --orphaned, or --finalize.')
  if (c.args.url.toLowerCase().startsWith('0x'))
    return records.filter(record => record.channel_id.toLowerCase() === c.args.url!.toLowerCase())
  const origin = normalizeOrigin(c.args.url)
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
  if (!shouldRenderText(globals)) return response
  if (sessions.length === 0) {
    process.stdout.write(`${emptyMessage}\n`)
    return undefined
  }
  for (const session of sessions) renderSessionText(session)
  process.stdout.write(`${sessions.length} ${countLabel}.\n`)
  return undefined
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
  if (!shouldRenderText(globals)) return response
  if (globals.silent) return undefined
  process.stderr.write(`[DRY RUN] Would close ${targets.length} session(s)\n`)
  for (const target of targets) {
    process.stderr.write(
      `  ${target.origin ? `${target.origin} (${target.channel_id})` : target.channel_id}\n`
    )
  }
  return undefined
}

function renderCloseSummary(globals: GlobalOptions, records: ChannelRecord[]) {
  const results = records.map(record => ({
    channel_id: record.channel_id.toLowerCase(),
    status: 'closed',
    ...(record.origin ? { origin: record.origin } : {})
  }))
  const response = { closed: results.length, failed: 0, pending: 0, results }
  if (!shouldRenderText(globals)) return response
  if (globals.silent) return undefined
  process.stdout.write(
    results.length === 0 ? 'No channel to close.\n' : `${results.length} closed\n`
  )
  return undefined
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
  const db = new NodeSqlite.DatabaseSync(channelDbPath())
  try {
    const deleteChannel = db.prepare('DELETE FROM channels WHERE LOWER(channel_id) = LOWER(?)')
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : ''
}

function errorCode(error: unknown) {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

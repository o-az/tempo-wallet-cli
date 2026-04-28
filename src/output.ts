import { z } from 'incur'

export const envSchema = z.object({
  TEMPO_AUTH_URL: z.string().optional(),
  TEMPO_HOME: z.string().optional(),
  TEMPO_SERVICES_URL: z.string().optional(),
  TEMPO_WALLET_DISABLE_BROWSER_OPEN: z.string().optional(),
  TEMPO_WALLET_FUND_POLL_INTERVAL_MS: z.string().optional(),
  TEMPO_WALLET_FUND_TIMEOUT_MS: z.string().optional(),
  TEMPO_WALLET_POLL_INTERVAL_MS: z.string().optional()
})

export const globalOptionsSchema = z.object({
  network: z.string().optional(),
  silent: z.boolean().default(false),
  verbose: z.number().default(0)
})

export type TempoEnv = z.infer<typeof envSchema>

export type GlobalOptions = z.infer<typeof globalOptionsSchema> & {
  agent: boolean
  env: TempoEnv
  format: string
  formatExplicit: boolean
}

export function shouldRenderText(globals: GlobalOptions) {
  return !globals.agent && !globals.formatExplicit
}

export function formatVerificationCode(code: string) {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code
}

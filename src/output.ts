export type GlobalOptions = {
  format: string
  formatExplicit: boolean
  network?: string | undefined
  silent: boolean
  verbose: number
}

export function shouldRenderText(globals: GlobalOptions) {
  return !globals.formatExplicit
}

export function formatVerificationCode(code: string) {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code
}

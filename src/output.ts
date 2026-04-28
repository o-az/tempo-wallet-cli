import { encode } from '@toon-format/toon'

export type OutputFormat = 'text' | 'json' | 'toon'

export type GlobalOptions = {
  format: OutputFormat
  network?: string | undefined
  silent: boolean
  verbose: number
}

export function emit(format: OutputFormat, value: unknown, renderText: () => string | void) {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(value)}\n`)
    return
  }

  if (format === 'toon') {
    process.stdout.write(`${quoteToonHex(encode(value))}\n`)
    return
  }

  const text = renderText()
  if (typeof text === 'string' && text.length > 0) process.stderr.write(text)
}

export function formatVerificationCode(code: string) {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code
}

function quoteToonHex(input: string) {
  return input.replace(/(^|[\s:[,{|])(?<hex>0x[0-9a-fA-F]+)(?=$|[\s:\]},|])/g, '$1"$<hex>"')
}

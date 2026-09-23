/**
 * Structured JSON logs, one line per event, with a request id. Never pass a
 * key, a full signature, or a full request body in here.
 */
export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

const REDACT = /key|secret|token|signature$|authorization/i

function clean(fields: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) out[k] = REDACT.test(k) ? '[redacted]' : typeof v === 'bigint' ? v.toString() : v
  return out
}

export const jsonLogger: Logger = {
  info: (event, fields) => console.log(JSON.stringify({ level: 'info', at: new Date().toISOString(), event, ...clean(fields) })),
  error: (event, fields) => console.error(JSON.stringify({ level: 'error', at: new Date().toISOString(), event, ...clean(fields) })),
}

export const silentLogger: Logger = { info: () => {}, error: () => {} }

import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('../../', import.meta.url))

export function attachPageDiagnostics(page) {
  const diagnostics = { console: [], requestFailed: [] }
  page.on('console', message => diagnostics.console.push({ type: message.type(), text: message.text() }))
  page.on('pageerror', error => diagnostics.console.push({ type: 'pageerror', text: error.message }))
  page.on('requestfailed', request => diagnostics.requestFailed.push({ method: request.method(), url: request.url(), failure: request.failure()?.errorText ?? null }))
  return diagnostics
}

export function serializeError(error) {
  return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
}

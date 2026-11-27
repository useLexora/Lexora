import process from 'node:process'
import { startDesktopServiceEntry } from './app/desktopServiceEntry'
import { registerDesktopSchemes } from './app/registerDesktopSchemes'

registerDesktopSchemes()
if (process.platform === 'win32') {
  // Electron loads Chromium Local State when evaluation of this ESM entry finishes.
  const gate = Promise.withResolvers<void>()
  void start(gate.resolve).finally(gate.resolve)
  // eslint-disable-next-line antfu/no-top-level-await -- Electron must not finish loading this entry before sessionData is bound.
  await gate.promise
}
else {
  void start()
}

async function start(allowReady?: () => void) {
  let failure: { cause: unknown } | undefined
  try {
    if (await startDesktopServiceEntry(allowReady))
      return
  }
  catch (cause) { failure = { cause } }
  const { startDesktopApplication } = await import('./app/DesktopApplication')
  await startDesktopApplication(allowReady, failure)
}

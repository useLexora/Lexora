import { startDesktopServiceEntry } from './app/desktopServiceEntry'
import { registerDesktopSchemes } from './app/registerDesktopSchemes'

registerDesktopSchemes()
void startDesktopServiceEntry().then(async (handled) => {
  if (!handled) {
    const { startDesktopApplication } = await import('./app/DesktopApplication')
    await startDesktopApplication()
  }
})

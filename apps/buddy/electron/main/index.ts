import { startDesktopApplication } from './app/DesktopApplication'
import { startDesktopServiceEntry } from './app/desktopServiceEntry'
import { registerDesktopSchemes } from './app/environment'

registerDesktopSchemes()
void startDesktopServiceEntry().then(handled => handled ? undefined : startDesktopApplication())

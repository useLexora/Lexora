import { protocol } from 'electron'
import { ARTIFACT_PROTOCOL, ATTACHMENT_PROTOCOL, EXTENSION_PROTOCOL, FILE_ICON_PROTOCOL, FILE_PROTOCOL, RENDERER_PROTOCOL, THEME_ASSET_PROTOCOL } from '../../../shared/platform/desktopSchemes'
import { bootstrapStep } from './desktopBootstrap'

export function registerDesktopSchemes(): void {
  const base = { standard: true, secure: true, supportFetchAPI: true }
  const stream = { ...base, stream: true }
  const cors = { ...stream, corsEnabled: true }
  bootstrapStep('register_protocols', () => protocol.registerSchemesAsPrivileged([
    { scheme: ATTACHMENT_PROTOCOL, privileges: cors },
    { scheme: ARTIFACT_PROTOCOL, privileges: cors },
    { scheme: FILE_PROTOCOL, privileges: stream },
    { scheme: RENDERER_PROTOCOL, privileges: { ...base, codeCache: true } },
    { scheme: EXTENSION_PROTOCOL, privileges: cors },
    { scheme: FILE_ICON_PROTOCOL, privileges: base },
    { scheme: THEME_ASSET_PROTOCOL, privileges: stream },
  ]))
}

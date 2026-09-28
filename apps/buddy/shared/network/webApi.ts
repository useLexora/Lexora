import type { RuntimeRequestContract } from '../runtime/apiContract'
import { z } from 'zod'
import { webCredentialInputSchema, webSettingsSchema, webSettingsSnapshotSchema } from './webProtocol'

export const webRpc = {
  settings: { method: 'web.settings', input: z.unknown(), response: webSettingsSnapshotSchema },
  saveSettings: { method: 'web.saveSettings', input: webSettingsSchema, response: webSettingsSnapshotSchema },
  saveCredential: { method: 'web.saveCredential', input: webCredentialInputSchema, response: webSettingsSnapshotSchema },
} as const satisfies Record<string, RuntimeRequestContract>

export const webSettingsChanged = { method: 'web.settingsChanged', params: z.object({ revision: z.number().int().positive(), operationId: z.uuid() }).strict() } as const

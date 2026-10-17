import { z } from 'zod'

export const developerToolsStateSchema = z.boolean()

export const developerToolsRpc = {
  get: 'host.developerTools.get',
} as const

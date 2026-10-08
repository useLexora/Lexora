import type { LoginOptions } from '@earendil-works/pi-ai'
import type { WorkspaceRepository } from '../storage/workspaceRepository'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

const DEVICE_ID_KEY = 'buddy.providers.device-id'

export function createProviderLoginOptions(settings: WorkspaceRepository): LoginOptions {
  return {
    agentName: 'Lexora',
    getDeviceId() {
      const stored = settings.get(DEVICE_ID_KEY)
      if (stored !== null)
        return z.uuid().parse(stored)
      const id = randomUUID()
      settings.set(DEVICE_ID_KEY, id, new Date().toISOString())
      return id
    },
  }
}

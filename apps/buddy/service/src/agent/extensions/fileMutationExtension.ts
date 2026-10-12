import type { BuddyInProcessExtension } from './BuddyInProcessExtension'
import { createEditToolDefinition, createWriteToolDefinition } from '@earendil-works/pi-coding-agent'

export const FILE_MUTATION_EXTENSION = 'lexora-file-mutation'

export function createFileMutationExtension(cwd: string): BuddyInProcessExtension {
  return {
    name: FILE_MUTATION_EXTENSION,
    factory(pi) {
      pi.registerTool(createEditToolDefinition(cwd))
      pi.registerTool(createWriteToolDefinition(cwd))
    },
  }
}

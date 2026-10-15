import type { MutationCoordinator } from '../../changes/MutationCoordinator'
import type { FileResourceCoordinator } from '../../files/FileResourceCoordinator'
import type { BuddyInProcessExtension } from './BuddyInProcessExtension'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Buffer } from 'node:buffer'
import { createEditToolDefinition, createWriteToolDefinition } from '@earendil-works/pi-coding-agent'

export const FILE_MUTATION_EXTENSION = 'lexora-file-mutation'

export function createFileMutationExtension(cwd: string, files: FileResourceCoordinator, mutations: MutationCoordinator): BuddyInProcessExtension {
  const invocation = () => {
    const current = mutations.getCurrentInvocation()
    if (!current)
      throw new Error('FILE_LEASE_INVALID')
    return current.invocationId
  }
  return {
    name: FILE_MUTATION_EXTENSION,
    factory(pi) {
      const signals = new AsyncLocalStorage<AbortSignal | undefined>()
      const versions = new Map<string, Map<string, string>>()
      const read = async (path: string) => {
        const id = invocation()
        const document = await files.read(id, path, signals.getStore())
        const entries = versions.get(id) ?? new Map<string, string>()
        entries.set(path, document.etag)
        versions.set(id, entries)
        return Buffer.from(document.text)
      }
      const edit = createEditToolDefinition(cwd, { operations: {
        readFile: read,
        access: async (path) => { await files.read(invocation(), path, signals.getStore()) },
        writeFile: async (path, text) => {
          const id = invocation()
          const expected = versions.get(id)?.get(path)
          if (!expected)
            throw new Error('FILE_LEASE_INVALID')
          await files.write(id, path, text, expected, signals.getStore())
        },
      } })
      pi.registerTool({ ...edit, async execute(...args) {
        const id = invocation()
        try {
          return await signals.run(args[2], () => edit.execute(...args))
        }
        finally { versions.delete(id) }
      } })
      const write = createWriteToolDefinition(cwd, { operations: {
        mkdir: async () => {},
        writeFile: (path, text) => files.write(invocation(), path, text, undefined, signals.getStore()),
      } })
      pi.registerTool({ ...write, execute: (...args) => signals.run(args[2], () => write.execute(...args)) })
    },
  }
}

import type { ReadToolDetails, ReadToolOptions, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { BuddyInProcessExtension } from './BuddyInProcessExtension'
import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { createReadToolDefinition, detectSupportedImageMimeTypeFromFile } from '@earendil-works/pi-coding-agent'
import { filePaths } from '../../../../platform/filesystem/filePaths'
import { projectReadHistory } from '../context/projectReadHistory'
import { decodeReadText, detectBinaryReadFormat, READ_CONTENT_NOTICE } from '../files/readFileContent'

export const READ_FILE_EXTENSION = 'lexora-read-file'

interface BuddyReadToolDetails extends ReadToolDetails {
  contentOmitted?: { format: string, sizeBytes: number }
}

export function createBuddyReadTool(cwd: string, options?: Pick<ReadToolOptions, 'autoResizeImages'>) {
  const native = createReadToolDefinition(cwd, options)
  const tool: ToolDefinition<typeof native.parameters, BuddyReadToolDetails | undefined> = {
    ...native,
    description: `${native.description}\nBOM-marked UTF-16 text is decoded. Recognized media, PDF, and archive/container formats return metadata with a notice that no content was extracted. Use native content for the sent snapshot when supplied, or a format-aware tool for the current file. For byte inspection, use a bounded hex dump.`,
    promptGuidelines: ['Use read for text and supported images instead of cat or sed. read does not play audio or video or extract document contents.'],
    async execute(toolCallId, parameters, signal, onUpdate, context) {
      signal?.throwIfAborted()
      const path = filePaths.resolveInput(parameters.path, context.cwd || cwd)
      const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
      let bytes: Buffer
      try {
        const metadata = await handle.stat()
        if (!metadata.isFile())
          throw new Error('read requires a regular file. Use a directory listing tool for directories; devices and pipes cannot be read.')
        const header = Buffer.alloc(16)
        const { bytesRead } = await handle.read(header, 0, header.length, 0)
        const format = detectBinaryReadFormat(header.subarray(0, bytesRead))
        if (format || metadata.size > 32 * 1024 * 1024) {
          const description = format ?? 'File exceeding the 32 MiB read memory limit'
          return {
            content: [{ type: 'text', text: `${description}, ${metadata.size} bytes. ${READ_CONTENT_NOTICE}` }],
            details: { contentOmitted: { format: description, sizeBytes: metadata.size } },
          }
        }
        bytes = Buffer.alloc(metadata.size)
        let position = 0
        while (position < bytes.length) {
          signal?.throwIfAborted()
          const read = await handle.read(bytes, position, Math.min(64 * 1024, bytes.length - position), position)
          if (!read.bytesRead)
            break
          position += read.bytesRead
        }
        bytes = bytes.subarray(0, position)
      }
      finally {
        await handle.close()
      }
      signal?.throwIfAborted()
      const format = detectBinaryReadFormat(bytes)
      if (format) {
        return {
          content: [{ type: 'text', text: `${format}, ${bytes.length} bytes. ${READ_CONTENT_NOTICE}` }],
          details: { contentOmitted: { format, sizeBytes: bytes.length } },
        }
      }
      const mimeType = await detectSupportedImageMimeTypeFromFile(path)
      const snapshot = mimeType ? bytes : Buffer.from(decodeReadText(bytes))
      const reader = createReadToolDefinition(cwd, {
        ...options,
        operations: {
          access: async () => {},
          readFile: async () => snapshot,
          detectImageMimeType: async () => mimeType,
        },
      })
      return reader.execute(toolCallId, parameters, signal, onUpdate, context)
    },
  }
  return tool
}

export function createReadFileExtension(cwd: string): BuddyInProcessExtension {
  return {
    name: READ_FILE_EXTENSION,
    factory(pi) {
      pi.registerTool(createBuddyReadTool(cwd))
      pi.on('context', event => ({ messages: projectReadHistory(event.messages) }))
      pi.on('session_before_compact', ({ preparation }) => {
        preparation.messagesToSummarize = projectReadHistory(preparation.messagesToSummarize, { omitImages: true })
        preparation.turnPrefixMessages = projectReadHistory(preparation.turnPrefixMessages, { omitImages: true })
      })
    },
  }
}

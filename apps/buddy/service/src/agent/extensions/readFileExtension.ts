import type { ReadToolDetails, ReadToolOptions, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { BuddyInProcessExtension } from './BuddyInProcessExtension'
import { Buffer } from 'node:buffer'
import { createReadToolDefinition } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { Check } from 'typebox/value'
import { filePaths } from '../../../../platform/filesystem/filePaths'
import { projectReadHistory } from '../context/projectReadHistory'
import { READ_CONTENT_NOTICE } from '../files/readFileContent'
import { readFileSnapshot } from '../files/readFileSnapshot'
import { describeTextFilePage, textFileReadStart } from '../files/readTextFilePage'

export const READ_FILE_EXTENSION = 'lexora-read-file'

interface BuddyReadToolDetails extends ReadToolDetails {
  contentOmitted?: { format: string, sizeBytes: number }
  textMaterial?: ReturnType<typeof describeTextFilePage>['metadata']
}

export function createBuddyReadTool(cwd: string, options?: Pick<ReadToolOptions, 'autoResizeImages'>) {
  const native = createReadToolDefinition(cwd, options)
  const parameters = Type.Object({
    ...native.parameters.properties,
    offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Line number to start reading from (1-indexed; legacy 0 also starts at line 1)' })),
    limit: Type.Optional(Type.Integer({ minimum: 1, description: 'Maximum number of lines to read' })),
    cursor: Type.Optional(Type.Integer({ minimum: 0, description: 'UTF-16 position within the offset line, starting at 0. Use next.cursor to continue a long line without skipping text.' })),
  })
  const tool: ToolDefinition<typeof parameters, BuddyReadToolDetails | undefined> = {
    ...native,
    parameters,
    description: `${native.description}\nThe file is read in its current state on each call. offset is still a 1-based line; cursor is a 0-based UTF-16 position within that line. Results state the delivered UTF-16 range (end exclusive), whether the end was reached, and exact next offset/cursor. Long lines can be continued without a shell. BOM-marked UTF-16 text is decoded. Recognized media, PDF, and archive/container formats return metadata with a notice that no content was extracted. Use native content for the sent snapshot when supplied, or a format-aware tool for the current file. For byte inspection, use a bounded hex dump.`,
    promptGuidelines: ['Use read for text and supported images instead of cat or sed. For a known location in a large text file, set offset and limit to read the relevant lines; read a small file in full when needed. read does not play audio or video or extract document contents.'],
    async execute(toolCallId, input, signal, onUpdate, context) {
      signal?.throwIfAborted()
      if (!Check(parameters, input))
        throw new Error('VALIDATION_FAILED')
      const path = filePaths.resolveInput(input.path, context.cwd || cwd)
      const snapshot = await readFileSnapshot(path, signal)
      if (snapshot.kind === 'omitted') {
        const { format, sizeBytes } = snapshot
        return {
          content: [{ type: 'text', text: `${format}, ${sizeBytes} bytes. ${READ_CONTENT_NOTICE}` }],
          details: { contentOmitted: { format, sizeBytes } },
        }
      }
      const start = snapshot.kind === 'text' ? textFileReadStart(snapshot.text, input.offset, input.cursor) : undefined
      const cursorRead = snapshot.kind === 'text' && input.cursor !== undefined
      const reader = createReadToolDefinition(cwd, {
        ...options,
        operations: {
          access: async () => {},
          readFile: async () => snapshot.kind === 'image' ? snapshot.bytes : Buffer.from(cursorRead ? snapshot.text.slice(start!.position) : snapshot.text),
          detectImageMimeType: async () => snapshot.kind === 'image' ? snapshot.mimeType : null,
        },
      })
      const result = await reader.execute(toolCallId, cursorRead ? { ...input, offset: 1 } : input, signal, onUpdate, context)
      if (snapshot.kind !== 'text' || !start)
        return result
      const page = describeTextFilePage(snapshot.text, start, input.limit, result.details)
      const body = page.text ?? (cursorRead ? snapshot.text.slice(start.position, page.metadata.range.end) : result.content.find(block => block.type === 'text')?.text ?? '')
      const text = `${body}\n\n[read ${JSON.stringify(page.metadata)}]`
      return {
        ...result,
        content: [{ type: 'text', text }],
        structuredContent: text,
        details: { ...page.text === undefined ? result.details : {}, textMaterial: page.metadata },
      }
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

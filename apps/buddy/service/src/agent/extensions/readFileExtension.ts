import type { ReadToolDetails, ReadToolOptions, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ImageReadingMaterialWriter } from '../../images/ImageReadingMaterialStore'
import type { ImageReader, ImageReadingResult } from '../../images/ImageReadingService'
import type { BuddyInProcessExtension } from './BuddyInProcessExtension'
import { Buffer } from 'node:buffer'
import { createReadToolDefinition } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { Check } from 'typebox/value'
import { filePaths } from '../../../../platform/filesystem/filePaths'
import { imageReadingRequest } from '../../images/imageReadingRequest'
import { imageReadingToolResult } from '../../images/imageReadingToolResult'
import { projectReadHistory } from '../context/projectReadHistory'
import { READ_CONTENT_NOTICE } from '../files/readFileContent'
import { readFileSnapshot } from '../files/readFileSnapshot'
import { describeTextFilePage, textFileReadStart } from '../files/readTextFilePage'

export const READ_FILE_EXTENSION = 'lexora-read-file'

interface BuddyReadToolDetails extends ReadToolDetails {
  imageReading?: Omit<Extract<ImageReadingResult, { kind: 'text' }>, 'text'>
  contentOmitted?: { format: string, sizeBytes: number }
  textMaterial?: ReturnType<typeof describeTextFilePage>['metadata'] & { path?: string, continuation?: 'unavailable' }
}

export function createBuddyReadTool(cwd: string, options?: Pick<ReadToolOptions, 'autoResizeImages'>, readImage?: ImageReader, writeImageMaterial?: ImageReadingMaterialWriter) {
  const native = createReadToolDefinition(cwd, options)
  const parameters = Type.Object({
    ...native.parameters.properties,
    imagePurpose: Type.Optional(Type.Union([Type.Literal('understand'), Type.Literal('extract'), Type.Literal('document')], { description: 'understand (default): answer visual questions, including screenshots, selected controls, switch states, colors, shapes, charts, and mixed text/visual content. extract: verbatim text transcription only; appearance and UI states are omitted. document: document headings, reading order and table layout.' })),
    imageQuestion: Type.Optional(Type.String({ maxLength: 8192, description: 'Focused visual question for this image. The host also supplies the current user request. For multiple images or saved tool-image references, use lexora_image_read.' })),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Line number to start reading from (1-indexed; legacy 0 also starts at line 1)' })),
    limit: Type.Optional(Type.Integer({ minimum: 1, description: 'Maximum number of lines to read' })),
    cursor: Type.Optional(Type.Integer({ minimum: 0, description: 'UTF-16 position within the offset line, starting at 0. Use next.cursor to continue a long line without skipping text.' })),
  })
  const tool: ToolDefinition<typeof parameters, BuddyReadToolDetails | undefined> = {
    ...native,
    parameters,
    description: 'Read one text file or image. For visual comparisons, send all images together to lexora_image_read; separate reads cannot compare pixels across images. Images use the configured image reader and may return a visual description instead of image bytes. Use understand for visual questions; extract only transcribes text and does not establish visual states. Text results include a UTF-16 range and exact next offset/cursor; use offset and limit for large files. BOM-marked UTF-16 is decoded. Recognized media, PDF, and archives return metadata only. Derived image text returns a bounded preview and a full-text path for continuation.',
    promptGuidelines: [
      'Use read for text and supported images. Use offset and limit for known locations in large files; follow the returned path and next offset/cursor to continue extracted image text without repeating image processing. Use a format-aware tool for other formats.',
      'For visual questions, use imagePurpose=understand and add any focused question in imageQuestion. For comparisons, inspect all relevant images together with lexora_image_read. Use extract only for text transcription; extracted labels do not establish colors, selections or switch states.',
    ],
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
      if (snapshot.kind === 'image' && readImage && context.model) {
        const result = await readImage({ operation: input.imagePurpose ?? 'understand', request: imageReadingRequest(context), question: input.imageQuestion ?? '', images: [{ reference: input.path, image: { type: 'image', data: snapshot.bytes.toString('base64'), mimeType: snapshot.mimeType } }], model: context.model, signal: signal ?? new AbortController().signal })
        return imageReadingToolResult(result, [input.path], signal, writeImageMaterial)
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

export function createReadFileExtension(cwd: string, readImage?: ImageReader, writeImageMaterial?: ImageReadingMaterialWriter): BuddyInProcessExtension {
  return {
    name: READ_FILE_EXTENSION,
    factory(pi) {
      pi.registerTool(createBuddyReadTool(cwd, undefined, readImage, writeImageMaterial))
      pi.on('context', event => ({ messages: projectReadHistory(event.messages) }))
      pi.on('session_before_compact', ({ preparation }) => {
        preparation.messagesToSummarize = projectReadHistory(preparation.messagesToSummarize, { omitImages: true })
        preparation.turnPrefixMessages = projectReadHistory(preparation.turnPrefixMessages, { omitImages: true })
      })
    },
  }
}

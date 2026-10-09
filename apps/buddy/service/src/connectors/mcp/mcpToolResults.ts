import type { ImageContent, JsonObject, TextContent } from '@earendil-works/pi-ai'
import type { CallToolResult } from '@modelcontextprotocol/client'
import { Buffer } from 'node:buffer'
import { McpClientError } from './mcpErrors'

export type McpResultWriter = (bytes: Uint8Array, mimeType: string, signal?: AbortSignal) => Promise<{ artifactId: string, path: string }>

const MAX_RESULT_BYTES = 32 * 1024 * 1024
const MAX_INLINE_TEXT = 64 * 1024
const MAX_INLINE_IMAGE = 4 * 1024 * 1024

export async function normalizeMcpResult(result: CallToolResult, write?: McpResultWriter, signal?: AbortSignal, includeImages = true) {
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES || (result.content?.length ?? 0) > 128)
    throw new McpClientError('MCP_RESULT_TOO_LARGE')
  const content: Array<TextContent | ImageContent> = []
  const artifactIds: string[] = []
  const text: string[] = []
  let imageBytes = 0
  const save = async (bytes: Uint8Array, mimeType: string) => {
    if (!write)
      return null
    signal?.throwIfAborted()
    try {
      const saved = await write(bytes, mimeType, signal)
      artifactIds.push(saved.artifactId)
      return saved
    }
    catch {
      signal?.throwIfAborted()
      return null
    }
  }
  for (const block of result.content ?? []) {
    signal?.throwIfAborted()
    if (block.type === 'text') {
      text.push(block.text)
    }
    else if (block.type === 'resource_link') {
      text.push(JSON.stringify({ type: block.type, name: block.name, uri: block.uri, mimeType: block.mimeType, description: block.description }))
    }
    else if (block.type === 'resource') {
      const resource = block.resource
      text.push(`Resource: ${resource.uri}`)
      if ('text' in resource) {
        text.push(resource.text)
      }
      else {
        const saved = await save(Buffer.from(resource.blob, 'base64'), resource.mimeType ?? 'application/octet-stream')
        text.push(saved ? JSON.stringify(saved) : '[Binary resource retained in the complete tool result; no file saved.]')
      }
    }
    else if (block.type === 'image' || block.type === 'audio') {
      const bytes = Buffer.from(block.data, 'base64')
      const saved = await save(bytes, block.mimeType)
      if (saved)
        text.push(JSON.stringify(saved))
      if (includeImages && block.type === 'image' && /^image\/(?:png|jpeg|webp|gif)$/.test(block.mimeType) && imageBytes + bytes.length <= MAX_INLINE_IMAGE) {
        imageBytes += bytes.length
        content.push({ type: 'image', data: block.data, mimeType: block.mimeType })
      }
      else if (!saved) {
        text.push(`[${block.type} retained in the complete tool result; no file saved.]`)
      }
    }
  }
  if (result.structuredContent !== undefined)
    text.push(JSON.stringify({ structuredContent: result.structuredContent }))
  const joined = text.filter(Boolean).join('\n') || 'MCP tool completed without text output'
  if (Buffer.byteLength(joined) > MAX_INLINE_TEXT) {
    const saved = await save(Buffer.from(joined), 'text/plain')
    content.unshift({ type: 'text', text: `${Buffer.from(joined).subarray(0, MAX_INLINE_TEXT / 2).toString()}\n[Preview; ${saved ? `complete result: ${JSON.stringify(saved)}` : 'no file saved. Use Codemode to filter the complete tool result.'}]` })
  }
  else {
    content.unshift({ type: 'text', text: joined })
  }
  const structuredContent = {
    content: result.content,
    ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
  }
  return { content, structuredContent: JSON.parse(JSON.stringify(structuredContent)) as JsonObject, artifactIds, isError: result.isError === true }
}

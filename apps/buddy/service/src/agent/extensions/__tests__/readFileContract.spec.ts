import type { ToolResultMessage } from '@earendil-works/pi-ai'
import type { ExtensionToolContext, ReadToolInput, ReadToolOptions } from '@earendil-works/pi-coding-agent'
import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { convertToLlm, serializeConversation } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareBuddyInputHistory } from '../../context/prepareBuddyInputHistory'
import { createBuddyReadTool } from '../readFileExtension'

function createReadTool(cwd: string, options?: Pick<ReadToolOptions, 'autoResizeImages'>) {
  const tool = createBuddyReadTool(cwd, options)
  return {
    execute: (id: string, parameters: ReadToolInput, signal?: AbortSignal) => tool.execute(id, parameters, signal, undefined, { cwd } as ExtensionToolContext),
  }
}

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'buddy-read-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const formats: [string, Buffer][] = [
  ['WAV audio', Buffer.concat([Buffer.from('RIFF'), Buffer.from([0xB6, 0x50, 0x0D, 0]), Buffer.from('WAVEfmt '), Buffer.alloc(50_000)])],
  ['AVI video', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI '), Buffer.alloc(32)])],
  ['MP4/M4A container', Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypM4A '), Buffer.alloc(8)])],
  ['AVIF image', Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypavif'), Buffer.alloc(8)])],
  ['HEIF image/container', Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypheic'), Buffer.alloc(8)])],
  ['WebM/Matroska container', Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0, 0, 0, 0])],
  ['ID3-tagged audio', Buffer.from('ID3\x04\0\0\0\0\0\0fixture')],
  ['MPEG audio', Buffer.from([0xFF, 0xFB, 0x90, 0x64])],
  ['Ogg media container', Buffer.from('OggS\0\0fixture')],
  ['FLAC audio', Buffer.from('fLaC\0\0\0\x22fixture')],
  ['ZIP archive/container', Buffer.from([80, 75, 3, 4, 0, 0])],
  ['OLE compound document', Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])],
  ['PDF document', Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF')],
]

describe('buddy read adapter contract', () => {
  it('inspects a sparse large file without loading its body and rejects directories', async () => {
    const path = join(root, 'large.bin')
    await writeFile(path, 'header')
    await truncate(path, 1024 * 1024 * 1024)
    const result = await createReadTool(root).execute('large', { path })
    expect(result.details?.contentOmitted).toEqual({ format: 'File exceeding the 32 MiB read memory limit', sizeBytes: 1024 * 1024 * 1024 })
    expect(JSON.stringify(result).length).toBeLessThan(1000)
    await expect(createReadTool(root).execute('directory', { path: root })).rejects.toThrow('regular file')
  })
  it.each(formats)('returns metadata and a next action for %s regardless of extension', async (format, bytes) => {
    await writeFile(join(root, 'renamed.txt'), bytes)
    const result = await createReadTool(root).execute('read', { path: 'renamed.txt', offset: 999 })
    expect(result).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('no file content was extracted') }],
      details: { contentOmitted: { format, sizeBytes: bytes.length } },
    })
    expect(result).not.toHaveProperty('isError', true)
    expect(JSON.stringify(result.content)).toContain('format-aware tool')
    expect(JSON.stringify(result.content)).toContain('bounded hex dump')
    expect(JSON.stringify(result.content)).not.toContain('\\u0000')
    expect(JSON.stringify(result).length).toBeLessThan(1000)
    expect(await readFile(join(root, 'renamed.txt'))).toEqual(bytes)
  })

  it('preserves text, embedded NUL, line selection and empty files regardless of extension', async () => {
    const content = '中文 🎵\nlog\0entry {"escaped":"\\u0000","replacement":"�"}\nlast line'
    await writeFile(join(root, 'named.wav'), content)
    expect((await createReadTool(root).execute('read', { path: 'named.wav' })).content).toEqual([{ type: 'text', text: content }])
    expect((await createReadTool(root).execute('read', { path: 'named.wav', offset: 2, limit: 1 })).content).toEqual([
      { type: 'text', text: 'log\0entry {"escaped":"\\u0000","replacement":"�"}\n\n[1 more lines in file. Use offset=3 to continue.]' },
    ])
    await writeFile(join(root, 'empty.txt'), '')
    expect((await createReadTool(root).execute('read', { path: 'empty.txt' })).content).toEqual([{ type: 'text', text: '' }])
  })

  it.each(['utf16le', 'utf16be'])('decodes BOM-marked %s text with line selection', async (encoding) => {
    const bytes = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('中文\nsecond line', 'utf16le')])
    if (encoding === 'utf16be')
      bytes.swap16()
    await writeFile(join(root, 'encoded.txt'), bytes)
    expect((await createReadTool(root).execute('read', { path: 'encoded.txt' })).content).toEqual([{ type: 'text', text: '中文\nsecond line' }])
    expect((await createReadTool(root).execute('read', { path: 'encoded.txt', offset: 2 })).content).toEqual([{ type: 'text', text: 'second line' }])
  })

  it('does not classify unrecognized encodings or isolated NUL as binary formats', async () => {
    const bytes = Buffer.from([0x63, 0x61, 0x66, 0xE9, 0, 0x0A])
    await writeFile(join(root, 'legacy.log'), bytes)
    expect((await createReadTool(root).execute('read', { path: 'legacy.log' })).content).toEqual([{ type: 'text', text: bytes.toString('utf8') }])
  })

  it('continues returning images as native content', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3xQAAAAASUVORK5CYII=', 'base64')
    await writeFile(join(root, 'pixel.png'), png)
    const result = await createReadTool(root, { autoResizeImages: false }).execute('read', { path: 'pixel.png' })
    expect(result.content).toContainEqual(expect.objectContaining({ type: 'image', mimeType: 'image/png', data: expect.any(String) }))
  })

  it('keeps filesystem failures and cancellation as failures', async () => {
    await expect(createReadTool(root).execute('read', { path: 'missing.txt' })).rejects.toThrow()
    await writeFile(join(root, 'exists.txt'), 'text')
    await expect(createReadTool(root).execute('read', { path: 'exists.txt' }, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
    await expect(createReadTool(root).execute('read', { path: 'exists.txt/child' })).rejects.toThrow()
  })
})

describe('historical binary read projection', () => {
  it.each(formats.filter(([format]) => !['MPEG audio', 'OLE compound document'].includes(format)))('omits recognizable %s output before budgeting and compaction without changing history', (_format, bytes) => {
    const text = `${bytes.toString('utf8')}${'\0'.repeat(40_782)}${'�'.repeat(2921)}\n[Showing lines 1-7 of 3545 (50.0KB limit). Use offset=8 to continue.]`
    const original: ToolResultMessage = {
      role: 'toolResult',
      toolName: 'read',
      toolCallId: 'read-audio',
      timestamp: 1,
      isError: false,
      content: [{ type: 'text', text }],
      details: { truncation: { content: text, truncated: true } },
    }
    const stored = structuredClone(original)
    const request = convertToLlm(prepareBuddyInputHistory([original]))
    expect(JSON.stringify(request).length).toBeLessThan(1000)
    expect(JSON.stringify(request)).not.toContain('\\u0000')
    expect(serializeConversation(request)).toContain('Earlier raw file output was omitted')
    expect(serializeConversation(request)).not.toContain('Showing lines')
    expect(prepareBuddyInputHistory([original])).toEqual(request)
    expect(request[0]).toMatchObject({ role: 'toolResult', toolName: 'read', toolCallId: 'read-audio', isError: false })
    expect(original).toEqual(stored)
  })

  it('preserves logs with NUL, uncertain decoded bytes, failures, images and other tools', () => {
    const base: ToolResultMessage = {
      role: 'toolResult',
      toolName: 'read',
      toolCallId: 'read-text',
      timestamp: 1,
      isError: false,
      content: [{ type: 'text', text: 'log\0entry: UTF-8 �; "\\u0000" is a literal JSON escape.' }],
      details: { truncation: { content: 'log\0entry', truncated: true } },
    }
    const messages: ToolResultMessage[] = [
      base,
      { ...base, content: [{ type: 'text', text: '\0unknown\0�' }] },
      { ...base, content: [{ type: 'text', text: 'Read image file [image/png]' }, { type: 'image', data: 'offline-image', mimeType: 'image/png' }] },
      { ...base, toolName: 'custom_read', content: [{ type: 'text', text: '%PDF-1.7\nstream' }] },
      { ...base, isError: true, content: [{ type: 'text', text: '%PDF-1.7\nerror reading file' }] },
    ]
    const result = convertToLlm(prepareBuddyInputHistory(messages))
    for (const [index, message] of messages.entries())
      expect(result[index]).toBe(message)
  })
})

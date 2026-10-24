import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_MAX_BYTES } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBuddyReadTool } from '../readFileExtension'

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'text-pagination-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})
function read(input: { offset?: number, limit?: number, cursor?: number }) {
  return createBuddyReadTool(directory).execute('read', { path: 'input.txt', ...input }, undefined, undefined, { cwd: directory } as ExtensionToolContext)
}

describe('read file continuation', () => {
  it('reads a long Unicode line completely with byte-bounded pages', async () => {
    const text = `${'a'.repeat(DEFAULT_MAX_BYTES - 1)}${'😀字'.repeat(20000)}\nlast line`
    await writeFile(join(directory, 'input.txt'), text)
    let next: { offset: number, cursor: number } | null = { offset: 1, cursor: 0 }
    let combined = ''
    let pages = 0
    while (next) {
      const result = await read(next)
      const metadata = result.details!.textMaterial!
      const output = result.content.find(block => block.type === 'text')!.text
      const body = output.slice(0, output.lastIndexOf('\n\n[read '))
      expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(DEFAULT_MAX_BYTES)
      expect(metadata.state).toBe('current')
      expect(metadata.range).toEqual({ unit: 'utf16', start: combined.length, end: combined.length + body.length })
      expect(output).toContain(JSON.stringify(metadata))
      expect(result.structuredContent).toBe(output)
      combined += body
      next = metadata.next
      expect(++pages).toBeLessThan(10)
    }
    expect(pages).toBeGreaterThan(2)
    expect(combined).toBe(text)
  })

  it('keeps line offset and limit semantics including empty lines and supports columns', async () => {
    await writeFile(join(directory, 'input.txt'), 'first\n\nA😀B\nlast')
    const empty = await read({ offset: 2, limit: 1 })
    expect(empty.details?.textMaterial).toEqual({ state: 'current', range: { unit: 'utf16', start: 6, end: 6 }, complete: false, next: { offset: 3, cursor: 0 } })
    const selected = await read({ offset: 3, cursor: 1, limit: 1 })
    expect(selected.content[0]).toMatchObject({ text: expect.stringContaining('😀B') })
    expect(selected.details?.textMaterial).toEqual({ state: 'current', range: { unit: 'utf16', start: 8, end: 11 }, complete: false, next: { offset: 4, cursor: 0 } })
    await expect(read({ offset: 3, cursor: 2 })).rejects.toThrow('READ_CURSOR_INSIDE_SURROGATE_PAIR')
    await expect(read({ offset: 3, cursor: 5 })).rejects.toThrow('READ_CURSOR_OUT_OF_RANGE')
    expect((await read({ offset: 4 })).details?.textMaterial).toMatchObject({ complete: true, next: null })
  })

  it('retains Pi line truncation and reads current source state on subsequent calls', async () => {
    await writeFile(join(directory, 'input.txt'), Array.from({ length: 2002 }, (_, index) => `line ${index + 1}`).join('\n'))
    const first = await read({})
    expect(first.details?.truncation).toMatchObject({ truncated: true, truncatedBy: 'lines', outputLines: 2000 })
    expect(first.details?.textMaterial).toMatchObject({ complete: false, next: { offset: 2001, cursor: 0 } })
    await writeFile(join(directory, 'input.txt'), 'changed')
    const current = await read({})
    expect((await read({ offset: 0 })).structuredContent).toBe(current.structuredContent)
    expect(current.content[0]).toMatchObject({ text: expect.stringContaining('changed') })
    expect(current.details?.textMaterial).toMatchObject({ state: 'current', complete: true, range: { start: 0, end: 7 } })
  })
})

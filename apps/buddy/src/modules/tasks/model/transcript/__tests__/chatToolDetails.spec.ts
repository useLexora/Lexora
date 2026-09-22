import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import { describe, expect, it } from 'vitest'
import { presentChatToolDiff } from '../chatToolDiff'
import { resolveChatToolFileTarget } from '../chatToolFileTarget'
import { presentChatToolRead, presentChatToolSearch } from '../chatToolText'

describe('tool text presentation', () => {
  it('numbers the returned file slice and keeps native continuation notices outside its lines', () => {
    const notice = '[Showing lines 41-43 of 800 (50.0KB limit). Use offset=44 to continue.]'
    const content = '<main>\n  Content\n</main>'
    expect(presentChatToolRead(`${content}\n\n${notice}`, 41, true)).toEqual({ content, numbers: '41\n42\n43', notice })
    const limited = '[5 more lines in file. Use offset=44 to continue.]'
    expect(presentChatToolRead(`${content}\n\n${limited}`, 41, true).notice).toBe(limited)
    expect(presentChatToolRead(`${content}\n\n${notice}`, 41, false).content).toBe(`${content}\n\n${notice}`)
    expect(presentChatToolRead('one\r\ntwo\n', 7, true)).toEqual({ content: 'one\r\ntwo\n', numbers: '7\n8\n9', notice: null })
  })

  it('keeps read image and oversized-line diagnostics as plain output', () => {
    for (const output of ['Read image file [image/png]\nResized', '[Line 4 is 1MB, exceeds 50KB limit. Use bash: sed -n \'4p\' example.txt]'])
      expect(presentChatToolRead(output, 4, true)).toEqual({ content: output, numbers: null, notice: null })
  })

  it('groups consecutive grep hits with their context and preserves unfamiliar output in place', () => {
    const output = 'src/My File.ts-11- before\nsrc/My File.ts:12: <script>literal</script>\nsrc/My File.ts-13- after\nC:\\work\\other.ts:9: value: 10\n\n[100 matches limit reached; narrow the path or pattern]\nUnexpected diagnostic'
    const result = presentChatToolSearch(output, 'grep')
    expect(result.blocks).toEqual([
      { kind: 'file', path: 'src/My File.ts', lines: [{ number: '11', text: 'before', match: false }, { number: '12', text: '<script>literal</script>', match: true }, { number: '13', text: 'after', match: false }] },
      { kind: 'file', path: 'C:\\work\\other.ts', lines: [{ number: '9', text: 'value: 10', match: true }] },
      { kind: 'text', text: '\n[100 matches limit reached; narrow the path or pattern]\nUnexpected diagnostic' },
    ])
    expect(result.remaining).toBe(0)
    expect(presentChatToolSearch('No matches found', 'grep').blocks).toEqual([{ kind: 'text', text: 'No matches found' }])
    expect(presentChatToolSearch(output, 'external_search').blocks).toEqual([{ kind: 'text', text: output }])
  })

  it('bounds mounted search results while allowing every remaining line to be revealed', () => {
    const output = Array.from({ length: 1000 }, (_, index) => `file.ts:${index + 1}: content`).join('\n')
    const first = presentChatToolSearch(output, 'grep')
    expect(first.remaining).toBe(800)
    expect(first.blocks[0]).toMatchObject({ kind: 'file', lines: expect.any(Array) })
    if (first.blocks[0]?.kind === 'file')
      expect(first.blocks[0].lines).toHaveLength(200)
    const all = presentChatToolSearch(output, 'grep', 1000)
    expect(all.remaining).toBe(0)
    if (all.blocks[0]?.kind === 'file')
      expect(all.blocks[0].lines.at(-1)).toEqual({ number: '1000', text: 'content', match: true })
  })
})

describe('tool file preview targets', () => {
  it.each([
    ['/workspace/project', 'src/main.ts', 'src/main.ts'],
    ['/workspace/project', './src/main.ts', 'src/main.ts'],
    ['/workspace/project', '/workspace/project/src/main.ts', 'src/main.ts'],
    ['/workspace/project', '/workspace/project-copy/main.ts', null],
    ['/workspace/project', '../private.txt', null],
    ['/workspace/project', 'src/../private.txt', null],
    ['/workspace/project', 'C:\\other\\main.ts', null],
    ['/workspace/project', 'https://example.com/file.ts', null],
    ['/workspace/project', '~/private.txt', null],
    ['/workspace/project', '', null],
    ['C:\\Project', 'c:\\project\\src\\main.ts', 'src/main.ts'],
    ['C:\\Project', 'src\\main.ts', 'src/main.ts'],
    ['\\\\host\\share', '\\\\host\\share\\src\\main.ts', 'src/main.ts'],
    ['/workspace/project', 'sandbox:/workspace/project/src/main.ts', 'src/main.ts'],
    ['/workspace/project', 'sandbox:src/main.ts', 'src/main.ts'],
    ['/workspace/project', 'file:///workspace/project/src/main.ts', 'src/main.ts'],
    ['/workspace/project', 'src/main.ts#L12', 'src/main.ts'],
  ])('maps %s and %s to a current authorized file target', (root, path, expected) => {
    const target = resolveChatToolFileTarget(space(root), path)
    expect(target?.path ?? null).toBe(expected)
    if (target)
      expect(target).toMatchObject({ directoryId: 'directory', revision: 2, spaceId: 'space' })
  })

  it('requires an active primary directory and carries its current revision', () => {
    const current = space('/workspace/project')
    expect(resolveChatToolFileTarget(null, 'main.ts')).toBeNull()
    expect(resolveChatToolFileTarget({ ...current, primaryDirectory: null }, 'main.ts')).toBeNull()
    expect(resolveChatToolFileTarget({ ...current, revokedAt: '2026-09-10T00:00:00Z' }, 'main.ts')).toBeNull()
    expect(resolveChatToolFileTarget({ ...current, primaryDirectory: { ...current.primaryDirectory!, revokedAt: '2026-09-10T00:00:00Z' } }, 'main.ts')).toBeNull()
    expect(resolveChatToolFileTarget({ ...current, primaryDirectory: { ...current.primaryDirectory!, revision: 3 } }, 'main.ts')?.revision).toBe(3)
  })
})

describe('tool diff presentation', () => {
  it('preserves numbered edit hunks and counts changed lines', () => {
    const diff = ' 10 <main>\n-11   Before\n+11   After\n+12   Added\n 13 </main>'
    const result = presentChatToolDiff(diff)
    expect(result.blocks.map(block => block.text).join('\n')).toBe(diff)
    expect(result).toMatchObject({ added: 2, deleted: 1 })
    expect(result.blocks.map(block => block.kind)).toEqual(['context', 'deleted', 'added', 'context'])
  })

  it('keeps unified diff headers out of the change counts and preserves literal markup', () => {
    const result = presentChatToolDiff('--- a/main.html\n+++ b/main.html\n@@ -1 +1 @@\n-before\n+<script>alert(1)</script>\n')
    expect(result).toMatchObject({ added: 1, deleted: 1 })
    expect(result.blocks[0]?.kind).toBe('meta')
    expect(result.blocks[2]?.text).toBe('+<script>alert(1)</script>')
  })

  it('keeps a large contiguous change in a bounded number of render blocks', () => {
    const diff = `-1 before\n${Array.from({ length: 10_000 }, (_, index) => `+${index + 1} after`).join('\n')}`
    const result = presentChatToolDiff(diff)
    expect(result).toMatchObject({ added: 10_000, deleted: 1 })
    expect(result.blocks).toHaveLength(2)
    expect(result.blocks.map(block => block.text).join('\n')).toBe(diff)
  })
})

function space(root: string): LocalSpace {
  const now = '2026-09-10T00:00:00Z'
  return { id: 'space', name: 'Preview', icon: 'folder', iconColor: 'default', memoryScope: 'space_only', activeRunCount: 0, additionalDirectories: [], createdAt: now, updatedAt: now, revokedAt: null, primaryDirectory: { id: 'directory', spaceId: 'space', root, canonicalRoot: root, revision: 2, accessGrantedAt: now, resourcesTrustedAt: now, createdAt: now, updatedAt: now, revokedAt: null } }
}

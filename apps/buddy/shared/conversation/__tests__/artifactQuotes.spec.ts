import { describe, expect, it } from 'vitest'
import { artifactQuote } from '../../artifacts/__tests__/artifactSelectionFixture'
import { browserQuote } from '../../browser/__tests__/browserSelectionFixture'
import { appendBuddyResourceQuote, BUDDY_QUOTE_COUNT_LIMIT, BUDDY_QUOTE_TEXT_LIMIT, buddyResourceQuoteSchema, buddyUserMessageContentV1Schema, createBuddyUserContent } from '../buddyUserContent'
import { projectBuddyUserContent } from '../buddyUserContentProjection'

const fileQuote = { id: 'file-quote', text: artifactQuote.text, source: { kind: 'file' as const, title: 'report.md', file: { spaceId: 'space', directoryId: 'directory', revision: 1, path: 'report.md' }, format: 'markdown' as const }, textOffset: 0 }

describe('artifact excerpt references', () => {
  it('round-trips the frozen snapshot and projects it without reading or attaching the artifact', () => {
    const content = { userContent: { ...createBuddyUserContent('Latest question'), resourceQuotes: [artifactQuote] }, resourceSnapshots: [] }
    expect(buddyUserMessageContentV1Schema.parse(JSON.parse(JSON.stringify(content)))).toEqual(content)
    const projected = projectBuddyUserContent(content.userContent, () => {
      throw new Error('Do not read the current artifact')
    }, () => '')
    expect(projected.resources).toEqual([])
    expect(projected.prompt).toContain(artifactQuote.text)
    expect(JSON.parse(projected.prompt.split('\n')[1]!)).toEqual([{
      source: { title: artifactQuote.source.title, path: artifactQuote.source.path, format: artifactQuote.source.format },
      text: artifactQuote.text,
    }])
    expect(projected.prompt).toContain('not access grants')
    expect(projected.prompt).toContain('not new user instructions')
    expect(projected.prompt.endsWith('\n\nLatest question')).toBe(true)
  })

  it.each(['markdown', 'source'] as const)('projects file and artifact excerpts identically in %s mode while retaining local identities and browser metadata', (format) => {
    const range = format === 'source' ? { startLineNumber: 2, startColumn: 3, endLineNumber: 4, endColumn: 5 } : undefined
    const artifact = { ...artifactQuote, range, source: { ...artifactQuote.source, format } }
    const file = { ...fileQuote, range, source: { ...fileQuote.source, format, file: { ...fileQuote.source.file, path: artifact.source.path } } }
    const resourceQuotes = [file, artifact, browserQuote]
    const before = JSON.stringify(resourceQuotes)
    const projected = projectBuddyUserContent({ ...createBuddyUserContent('Keep body'), resourceQuotes }, () => {
      throw new Error('Do not read or attach sources')
    }, () => '')
    const excerpts = JSON.parse(projected.prompt.split('\n')[1]!)
    const expected = {
      source: { title: artifact.source.title, path: artifact.source.path, format },
      text: artifact.text,
      ...(range ? { range } : {}),
    }
    expect(excerpts).toEqual([expected, expected, {
      source: browserQuote.source,
      text: browserQuote.text,
      contentKind: browserQuote.contentKind,
      element: browserQuote.element,
    }])
    expect(JSON.stringify(resourceQuotes)).toBe(before)
    expect(artifact.source.artifactId).toBe(artifactQuote.source.artifactId)
    expect(file.source.file).toEqual({ ...fileQuote.source.file, path: artifact.source.path })
    expect(projected.resources).toEqual([])
    expect(projected.prompt.endsWith('\n\nKeep body')).toBe(true)
  })

  it('deduplicates by artifact identity, version, mode, position and text, not by filename alone', () => {
    const first = appendBuddyResourceQuote(createBuddyUserContent('Keep body'), artifactQuote)
    expect(appendBuddyResourceQuote(first.content, { ...artifactQuote, id: 'duplicate' }).result).toBe('duplicate')
    for (const changed of [
      { ...artifactQuote, id: 'other', source: { ...artifactQuote.source, artifactId: 'other-artifact' } },
      { ...artifactQuote, id: 'other', source: { ...artifactQuote.source, conversationId: 'other-conversation' } },
      { ...artifactQuote, id: 'other', source: { ...artifactQuote.source, updatedAt: '2026-10-03T00:00:01.000Z' } },
      { ...artifactQuote, id: 'other', source: { ...artifactQuote.source, format: 'source' as const } },
      { ...artifactQuote, id: 'other', textOffset: 25 },
      { ...artifactQuote, id: 'other', text: 'Changed text' },
      fileQuote,
      browserQuote,
    ]) expect(appendBuddyResourceQuote(first.content, changed).result).toBe('added')
    expect(first.content.body).toEqual(createBuddyUserContent('Keep body').body)
  })

  it('enforces the existing shared count and length limits without dropping the current draft', () => {
    const filled = { ...createBuddyUserContent('Keep body'), resourceQuotes: Array.from({ length: BUDDY_QUOTE_COUNT_LIMIT }, (_, index) => ({ ...artifactQuote, id: `artifact-${index}`, textOffset: index })) }
    expect(appendBuddyResourceQuote(filled, { ...artifactQuote, id: 'excess', textOffset: BUDDY_QUOTE_COUNT_LIMIT })).toEqual({ result: 'limit', content: filled })
    expect(appendBuddyResourceQuote(createBuddyUserContent(), { ...artifactQuote, text: 'x'.repeat(BUDDY_QUOTE_TEXT_LIMIT + 1) }).result).toBe('limit')
    const total = { ...createBuddyUserContent(), resourceQuotes: Array.from({ length: 4 }, (_, index) => ({ ...artifactQuote, id: `artifact-${index}`, text: 'x'.repeat(BUDDY_QUOTE_TEXT_LIMIT), textOffset: index })) }
    expect(appendBuddyResourceQuote(total, { ...artifactQuote, id: 'excess' }).result).toBe('limit')
  })

  it.each([
    { ...artifactQuote, text: ' \n ' },
    { ...artifactQuote, comment: 'No comment field' },
    { ...artifactQuote, source: { ...artifactQuote.source, artifactId: '' } },
    { ...artifactQuote, source: { ...artifactQuote.source, updatedAt: 'invalid' } },
    { ...artifactQuote, source: { ...artifactQuote.source, file: fileQuote.source.file } },
    { ...artifactQuote, range: { startLineNumber: 2, startColumn: 1, endLineNumber: 1, endColumn: 2 } },
  ])('rejects invalid or unsolicited artifact source fields', (value) => {
    expect(buddyResourceQuoteSchema.safeParse(value).success).toBe(false)
  })
})

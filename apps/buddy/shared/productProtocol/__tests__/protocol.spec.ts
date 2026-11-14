import { describe, expect, it } from 'vitest'
import { assertProductContentActions, productContentSchema, productEditableContentSchema, projectProductContent, restoreProductContent } from '../content'
import { productInitializeSchema } from '../identity'
import { getProductMethod } from '../methods'
import { decodeProductCursor, decodeSafeProductRevision, encodeProductCursor, encodeProductRevision, productRevisionSchema } from '../scalars'
import vectors from '../vectors.json'

describe('portable product contract', () => {
  it('consumes the cross-language request and scalar vectors', () => {
    for (const vector of vectors.requests) {
      const schema = vector.method === 'initialize' ? productInitializeSchema : getProductMethod(vector.method)?.input
      expect(schema?.safeParse(vector.params).success ?? false, vector.name).toBe(vector.valid)
    }
    for (const vector of vectors.responses)
      expect(getProductMethod(vector.method)?.output.safeParse(vector.result).success ?? false, vector.name).toBe(vector.valid)
    for (const vector of vectors.contents)
      expect(productContentSchema.safeParse(vector.value).success, vector.name).toBe(vector.valid)
    for (const vector of vectors.revisions)
      expect(productRevisionSchema.safeParse(vector.value).success, vector.name).toBe(vector.valid)
  })

  it('round trips signed SQLite upper bound without passing through a number', () => {
    expect(encodeProductRevision(9_223_372_036_854_775_807n)).toBe('9223372036854775807')
    expect(() => encodeProductRevision(9_007_199_254_740_992)).toThrow()
    expect(() => decodeSafeProductRevision('9007199254740992')).toThrow()
    const expected = { scope: 'messages', branchId: 'branch-1', revision: '9007199254740992' }
    const cursor = encodeProductCursor({ version: 1, ...expected, upperBound: '9223372036854775807', position: '9007199254740993' })
    expect(decodeProductCursor(cursor, expected).position).toBe('9007199254740993')
    expect(() => decodeProductCursor(cursor, { ...expected, revision: '9007199254740993' })).toThrow('CURSOR_EXPIRED')
    expect(() => decodeProductCursor(cursor, { ...expected, branchId: 'branch-2' })).toThrow('CURSOR_EXPIRED')
  })

  it('preserves Chinese, surrogate pairs, UTF-16 offsets and controlled original resource semantics', () => {
    const source = {
      version: 1 as const,
      body: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: '你好😀世界' }, { type: 'quote_ref' as const, quoteKind: 'resource' as const, quoteId: 'q1' }] }],
      panelResourceIds: [],
      resourceQuotes: [{ id: 'q1', text: '世界', textOffset: 4, source: { kind: 'artifact' as const, title: '报告', artifactId: 'a1', conversationId: 'c1', runId: 'r1', path: '/private/example/report.md', updatedAt: '2026-01-01T00:00:00.000Z', format: 'markdown' as const } }],
    }
    const portable = projectProductContent(source, () => ({ resourceId: 'material-1', title: '报告' }))
    expect(JSON.stringify(portable)).not.toContain('/private')
    expect(portable.resourceQuotes?.[0]?.textOffset).toBe(4)
    expect(restoreProductContent(portable, () => source.resourceQuotes[0]!)).toEqual(source)
    expect(() => restoreProductContent(portable, () => ({ ...source.resourceQuotes[0]!, text: 'changed' }))).toThrow('SOURCE_CHANGED')
    expect(productEditableContentSchema.safeParse({ ...portable, version: 2 }).success).toBe(false)
  })

  it('never permits embedded action directives based on client kind', () => {
    const content = productEditableContentSchema.parse({ version: 1, body: [{ type: 'paragraph', content: [{ type: 'prompt_directive', directive: 'slash_command', commandMode: 'action', commandId: 'plugins.install', value: '/install' }] }], panelResourceIds: [] })
    expect(() => assertProductContentActions(content, new Set(['compact']))).toThrow('ACTION_NOT_ALLOWED')
  })
})

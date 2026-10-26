import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { executionBriefSchema, executionReviewSchema, executionSubmissionSchema } from '../../../../../shared/executions/executionWork'
import { EXECUTION_RESULT_PAGE_BYTES, executionResultPage } from '../executionResultPage'

describe('bounded collaboration results', () => {
  it.each([
    ['ASCII', 'a'],
    ['Chinese', '验收'],
    ['emoji', '🦊'],
    ['JSON escaping', '\n\t"\\'],
    ['mixed', 'a汉🦊\n'],
  ])('reconstructs %s results within the serialized UTF-8 page budget', (_name, token) => {
    const report = token!.repeat(40000)
    const pages: string[] = []
    let offset = 0
    do {
      const page = executionResultPage({ runId: 'child', work: { submission: { summary: '证据'.repeat(1000) } } }, report, offset)
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(EXECUTION_RESULT_PAGE_BYTES)
      expect(page.result!.isWellFormed()).toBe(true)
      expect(page.result).toBe(report.slice(offset, page.nextOffset ?? report.length))
      pages.push(page.result!)
      if (page.nextOffset === null)
        break
      expect(page.nextOffset).toBeGreaterThan(offset)
      offset = page.nextOffset
    } while (true)
    expect(pages.join('')).toBe(report)
    expect(pages.length).toBeGreaterThan(1)
  })
  it.each([-1, 0.5, 2, 999])('rejects invalid or surrogate-splitting offset %s', (offset) => {
    expect(() => executionResultPage({}, 'a🦊', offset)).toThrow(RangeError)
  })
  it.each([null, ''])('represents pending and empty terminal output distinctly: %s', (report) => {
    expect(executionResultPage({}, report)).toEqual({ result: report, totalChars: 0, nextOffset: null })
  })
  it('bounds structured evidence before storage and result retrieval', () => {
    expect(executionBriefSchema.safeParse({ objective: '汉'.repeat(3000) }).success).toBe(false)
    expect(executionSubmissionSchema.safeParse({ summary: 'ready', evidence: ['x'.repeat(8000), 'y'.repeat(8000)], limitations: [] }).success).toBe(false)
    expect(executionReviewSchema.safeParse({ verdict: 'accepted', reason: 'x'.repeat(5000), evidence: [] }).success).toBe(false)
    expect(() => executionResultPage({ evidence: 'x'.repeat(EXECUTION_RESULT_PAGE_BYTES) }, 'a')).toThrow(RangeError)
  })
})

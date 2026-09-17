import { describe, expect, it } from 'vitest'
import { feedbackIssueInputSchema, lexoraConfigPatchSchema, releasePageInputSchema } from '../desktopApiSchemas'

describe('desktop Preload API contract', () => {
  it('accepts release pages from the canonical repository', () => {
    const url = 'https://github.com/useLexora/Lexora/releases/tag/v0.6.6'
    expect(releasePageInputSchema.parse({ url })).toEqual({ url })
  })

  it('limits feedback text before it crosses the desktop bridge', () => {
    expect(feedbackIssueInputSchema.parse({ feedback: '建议' })).toEqual({ feedback: '建议' })
    expect(() => feedbackIssueInputSchema.parse({ feedback: 'x'.repeat(4_001) })).toThrow()
  })

  it('rejects duplicate task sidebar pins', () => {
    expect(() => lexoraConfigPatchSchema.parse({
      desktop: {
        taskSidebarPinnedItems: [
          { id: 'space-a', kind: 'space' },
          { id: 'space-a', kind: 'space' },
        ],
      },
    })).toThrow()
  })

  it('accepts task sidebar layout preferences and rejects duplicates and unknown sections', () => {
    expect(lexoraConfigPatchSchema.parse({
      desktop: {
        taskSidebar: {
          collapsed: true,
          collapsedSections: ['tasks', 'spaces'],
          collapsedSpaces: ['space-a'],
          width: 336,
        },
      },
    })).toEqual({
      desktop: {
        taskSidebar: {
          collapsed: true,
          collapsedSections: ['tasks', 'spaces'],
          collapsedSpaces: ['space-a'],
          width: 336,
        },
      },
    })
    expect(lexoraConfigPatchSchema.parse({ desktop: { taskSidebar: { width: null } } }))
      .toEqual({ desktop: { taskSidebar: { width: null } } })
    expect(() => lexoraConfigPatchSchema.parse({
      desktop: { taskSidebar: { collapsedSections: ['tasks', 'tasks'] } },
    })).toThrow()
    expect(() => lexoraConfigPatchSchema.parse({
      desktop: { taskSidebar: { collapsedSections: ['sidebar'] } },
    })).toThrow()
    expect(() => lexoraConfigPatchSchema.parse({
      desktop: { taskSidebar: { collapsedSpaces: ['space-a', 'space-a'] } },
    })).toThrow()
    expect(() => lexoraConfigPatchSchema.parse({
      desktop: { taskSidebar: { collapsed: 'yes' } },
    })).toThrow()
  })

  it('rejects unknown, secret-like, and lifecycle-breaking settings', () => {
    expect(() => lexoraConfigPatchSchema.parse({
      agent: {
        providerCredential: 'not-allowed',
      },
    })).toThrow()

    expect(() => lexoraConfigPatchSchema.parse({
      buddy: {
        enabled: false,
      },
    })).toThrow()

    expect(() => lexoraConfigPatchSchema.parse({
      desktop: {
        closeBehavior: 'quit',
      },
    })).toThrow()
  })
})

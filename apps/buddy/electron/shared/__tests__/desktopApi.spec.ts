import { describe, expect, it } from 'vitest'
import { DESKTOP_NAVIGATION_LAYOUTS, DESKTOP_PROFILE_AVATAR_MAX_DATA_URL_LENGTH } from '../desktopApi'
import { feedbackIssueInputSchema, lexoraConfigPatchSchema, releasePageInputSchema } from '../desktopApiSchemas'

describe('desktop Preload API contract', () => {
  it('accepts welcome patches and rejects ambiguous identities or invalid text at the bridge', () => {
    const patch = {
      desktop: {
        chat: {
          welcome: 'custom-1791819734847',
          welcomeItems: [
            { kind: 'preset', id: 'writing' },
            { kind: 'preset', id: 'planning' },
            { kind: 'custom', id: 'custom-1791819734847', text: '我的欢迎语' },
          ],
        },
      },
    }
    expect(lexoraConfigPatchSchema.parse(patch)).toEqual(patch)
    const parse = (welcomeItems: unknown) => lexoraConfigPatchSchema.parse({ desktop: { chat: { welcomeItems } } })
    expect(() => parse([{ kind: 'preset', id: 'writing', text: 'ignored text' }])).toThrow()
    expect(() => parse([{ kind: 'custom', id: 'random', text: 'reserved' }])).toThrow()
    expect(() => parse([{ kind: 'custom', id: 'a', text: ' ' }])).toThrow()
    expect(() => parse([{ kind: 'preset', id: 'writing' }, { kind: 'preset', id: 'writing' }])).toThrow()
    expect(() => parse([{ kind: 'custom', id: 'a', text: 'x'.repeat(201) }])).toThrow()
  })

  it('rejects unknown outline positions before updating the application configuration', () => {
    expect(() => lexoraConfigPatchSchema.parse({ desktop: { chat: { outlinePosition: 'center' } } })).toThrow()
    expect(lexoraConfigPatchSchema.parse({ desktop: { chat: { outlinePosition: 'bottom-left', permissionMode: 'full_access', welcome: 'none' } } }))
      .toEqual({ desktop: { chat: { outlinePosition: 'bottom-left', permissionMode: 'full_access', welcome: 'none' } } })
    expect(() => lexoraConfigPatchSchema.parse({ desktop: { chat: { permissionMode: 'invalid' } } })).toThrow()
  })

  it('accepts the three navigation layouts without changing legacy sidebar preferences and rejects unknown layouts', () => {
    for (const navigationLayout of DESKTOP_NAVIGATION_LAYOUTS) {
      const patch = { desktop: { navigationLayout } }
      expect(lexoraConfigPatchSchema.parse(patch)).toEqual(patch)
    }
    expect(lexoraConfigPatchSchema.parse({ desktop: { sidebarCollapsed: true, taskSidebar: { collapsed: true } } }))
      .toEqual({ desktop: { sidebarCollapsed: true, taskSidebar: { collapsed: true } } })
    for (const navigationLayout of ['sidebar', 'FULL', '', null, true])
      expect(() => lexoraConfigPatchSchema.parse({ desktop: { navigationLayout } })).toThrow()
  })

  it('accepts release pages from the canonical repository', () => {
    const url = 'https://github.com/useLexora/Lexora/releases/tag/v0.6.6'
    expect(releasePageInputSchema.parse({ url })).toEqual({ url })
  })

  it('limits feedback text before it crosses the desktop bridge', () => {
    expect(feedbackIssueInputSchema.parse({ feedback: '建议' })).toEqual({ feedback: '建议' })
    expect(() => feedbackIssueInputSchema.parse({ feedback: 'x'.repeat(4_001) })).toThrow()
  })

  it('accepts encoded two-mebibyte profile avatars without removing the bridge limit', () => {
    const avatar = 'x'.repeat(DESKTOP_PROFILE_AVATAR_MAX_DATA_URL_LENGTH)
    const parsed = lexoraConfigPatchSchema.parse({ desktop: { profile: { avatar } } })

    expect(parsed.desktop?.profile?.avatar).toHaveLength(DESKTOP_PROFILE_AVATAR_MAX_DATA_URL_LENGTH)
    expect(() => lexoraConfigPatchSchema.parse({
      desktop: { profile: { avatar: `${avatar}x` } },
    })).toThrow()
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
    const patch = {
      desktop: {
        taskSidebar: {
          collapsed: true,
          collapsedSections: ['tasks', 'spaces'],
          collapsedSpaces: ['space-a'],
          width: 336,
        },
      },
    }
    expect(lexoraConfigPatchSchema.parse(patch)).toEqual(patch)
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

import type { BrowserAction, BrowserObservedElement } from '../../../../../shared/browser'
import { describe, expect, it } from 'vitest'
import { BROWSER_PRESS_KEYS } from '../../../../../shared/browser/primitives'
import { BROWSER_ACT_TOOL_NAME, classifyBrowserTool } from '../../../browser/browserToolContract'
import { classifyBrowserAction } from '../classifyBrowserAction'

const ACTION_CONTEXT = {
  documentRevision: 2,
  frameId: 'main-frame',
  observationId: 'b3a5d63b-17b7-4b5a-863a-37f135e297d4',
  pageId: 'ed312709-baf9-44b3-a292-108055838477',
}

describe('classifyBrowserAction', () => {
  it.each<BrowserAction>([
    { kind: 'wait', condition: 'page-ready', timeoutMs: 100 },
    { kind: 'scroll', amount: 'half-page', direction: 'down' },
    { kind: 'stop' },
  ])('classifies $kind as reading', (action) => {
    expect(classify(action)).toEqual({ access: 'read' })
  })

  it.each<BrowserAction>([
    { kind: 'navigate', url: 'https://example.com/docs' },
    { kind: 'back' },
    { kind: 'forward' },
    { kind: 'reload' },
    { kind: 'click', ref: 'e1' },
    { kind: 'fill', ref: 'e1', text: 'release notes' },
    { kind: 'type', ref: 'e1', text: 'release notes' },
    { kind: 'select', ref: 'e1', values: ['one'] },
    ...BROWSER_PRESS_KEYS.map(key => ({ kind: 'press' as const, key })),
  ])('classifies $kind as interaction regardless of apparent reversibility', (action) => {
    expect(classify(action)).toEqual({ access: 'interaction' })
  })

  it.each(['退出截图模式', '进入截图模式', '发送消息', '提交表单', '发布文章', '购买套餐', '删除文档', '授权访问', '修改密码', 'Documentation'])(
    'does not infer approval requirements from the page label %s',
    (name) => {
      expect(classify({ kind: 'click', ref: 'e1' }, element({ name, role: 'button' })))
        .toEqual({ access: 'interaction' })
    },
  )

  it('blocks human-only input while allowing observation and scrolling', () => {
    const password = element({ actions: [], inputMode: 'human', name: 'Password', role: 'textbox', valueState: 'redacted' })
    for (const action of [
      { kind: 'fill', ref: 'e1', text: 'not-allowed' },
      { kind: 'click', ref: 'e1' },
      { kind: 'press', ref: 'e1', key: 'Enter' },
    ] satisfies BrowserAction[]) {
      expect(classify(action, password)).toEqual({ blocked: true, reason: 'BROWSER_HUMAN_INPUT_REQUIRED' })
    }
    expect(classify({ amount: 'half-page', direction: 'down', kind: 'scroll', ref: 'e1' }, password))
      .toEqual({ access: 'read' })
    expect(classify({ kind: 'wait', condition: 'page-ready', timeoutMs: 100 }, password))
      .toEqual({ access: 'read' })
    expect(classifyBrowserAction({
      action: { key: 'Space', kind: 'press' },
      observationContainsHumanInput: true,
      target: null,
    })).toEqual({ blocked: true, reason: 'BROWSER_HUMAN_INPUT_REQUIRED' })
  })

  it('rejects caller-supplied target metadata instead of using it to lower risk', () => {
    expect(classifyBrowserTool({
      input: {
        ...ACTION_CONTEXT,
        action: { kind: 'click', ref: 'e1' },
        target: {
          name: 'Harmless documentation link',
          role: 'link',
        },
      },
      toolName: BROWSER_ACT_TOOL_NAME,
    }, {
      classifyAction: () => ({ access: 'interaction' }),
    })).toEqual({ blocked: true, reason: 'VALIDATION_FAILED' })
  })
})

function classify(
  action: BrowserAction,
  target: BrowserObservedElement | null = null,
) {
  return classifyBrowserAction({
    action,
    observationContainsHumanInput: target?.inputMode === 'human',
    target,
  })
}

function element(
  input: Partial<BrowserObservedElement> & Pick<BrowserObservedElement, 'name' | 'role'>,
): BrowserObservedElement {
  return {
    actions: ['click'],
    frameId: 'main-frame',
    ref: 'e1',
    states: [],
    ...input,
  }
}

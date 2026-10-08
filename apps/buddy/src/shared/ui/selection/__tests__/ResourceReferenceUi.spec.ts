// @vitest-environment jsdom
import type { BuddyResourceQuote } from '@buddy-shared/conversation/buddyUserContent'
import { artifactQuote } from '@buddy-shared/artifacts/__tests__/artifactSelectionFixture'
import { createBuddyUserContent } from '@buddy-shared/conversation/buddyUserContent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, provide, shallowRef } from 'vue'
import ResourceQuoteStrip from '../ResourceQuoteStrip.vue'
import ResourceSelectionQuoteMenu from '../ResourceSelectionQuoteMenu.vue'
import { WorkbenchSelectionReferences, workbenchSelectionReferencesKey } from '../workbenchSelectionReferences'

const feedback = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), info: vi.fn() }))
vi.mock('naive-ui', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    useMessage: () => feedback,
    NIcon: defineComponent({ setup: (_, { slots }) => () => h('span', slots.default?.()) }),
    NButton: defineComponent({ setup: (_, { slots, attrs }) => () => h('button', attrs, [slots.icon?.(), slots.default?.()]) }),
    NPopover: defineComponent({ setup: (_, { slots }) => () => h('div', [slots.trigger?.(), slots.default?.()]) }),
    NDropdown: defineComponent({ props: ['show', 'options', 'menuProps', 'renderLabel'], emits: ['select'], setup: (props, { emit }) => () => props.show
      ? h('div', props.menuProps(), props.options.flatMap((option: { key: string, label: string, type?: string, disabled?: boolean, children?: { key: string, label: string }[] }) => option.type === 'divider'
          ? [h('hr')]
          : [
              h('button', { disabled: option.disabled, onClick: () => emit('select', option.key) }, props.renderLabel(option)),
              ...option.children?.map(child => h('button', { onClick: () => emit('select', child.key) }, props.renderLabel(child))) ?? [],
            ]))
      : null }),
  }
})
const quote: BuddyResourceQuote = { id: 'q', text: '<script>Do not execute</script>\nFrozen selected text', source: { kind: 'file', title: 'auth.ts', file: { spaceId: 's', directoryId: 'd', revision: 1, path: 'src/auth.ts' }, format: 'source' }, range: { startLineNumber: 24, startColumn: 1, endLineNumber: 38, endColumn: 2 } }
const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
})
async function mount(kind: 'menu' | 'strip', removable = true, snapshot: BuddyResourceQuote = quote) {
  const root = document.createElement('div')
  document.body.append(root)
  let menu!: InstanceType<typeof ResourceSelectionQuoteMenu>
  const content = shallowRef(createBuddyUserContent('Keep input'))
  const ownerKey = shallowRef('file:one')
  const locate = vi.fn(async () => false)
  const remove = vi.fn()
  const host = new WorkbenchSelectionReferences({ targets: () => [{ id: 'a', label: 'Pane 1 · Task A', identity: 'a:draft:epoch', scope: 'task:a', read: () => content.value, write: value => content.value = value }], source: () => ({ identity: 'file:one', owner: 'task:a' }), locate })
  const app = createApp(defineComponent({ setup() {
    provide(workbenchSelectionReferencesKey, host)
    return () => kind === 'menu'
      ? h(ResourceSelectionQuoteMenu, { ref: value => menu = value as InstanceType<typeof ResourceSelectionQuoteMenu>, viewId: 'file', ownerKey: ownerKey.value, language: 'zh-CN', visible: true })
      : h(ResourceQuoteStrip, { quotes: [snapshot], language: 'zh-CN', removable, onRemove: remove })
  } }))
  app.mount(root)
  let mounted = true
  const unmount = () => {
    if (mounted) {
      mounted = false
      app.unmount()
      root.remove()
    }
  }
  cleanups.push(unmount)
  await nextTick()
  return { root, menu, host, content, ownerKey, locate, remove, unmount }
}

describe('resource reference UI', () => {
  it('uses the current-conversation action when unsplit, with no comment form', async () => {
    const f = await mount('menu')
    f.menu.open(quote, 10, 20)
    await nextTick()
    expect(f.root.querySelectorAll('button')).toHaveLength(1)
    expect(f.root.textContent).toBe('引用到对话')
    expect(f.root.querySelector('[role="menu"]')?.classList.contains('buddy-selection-menu')).toBe(true)
    f.root.querySelector('button')!.click()
    await nextTick()
    expect(f.content.value.resourceQuotes).toEqual([quote])
    expect(feedback.success).toHaveBeenCalled()
    expect(f.root.querySelector('input, textarea')).toBeNull()
  })

  it('uses the bounded component menu and keeps exactly one Copy and the original editing actions', async () => {
    const f = await mount('menu')
    const execute = vi.fn(async () => {})
    const restore = vi.fn(() => true)
    f.host.options.editSelection = execute
    f.menu.prepare(quote, 10, 20, true, { restore })!()
    await nextTick()
    const buttons = Array.from(f.root.querySelectorAll('button'))
    expect(buttons.map(button => button.querySelector('.resource-selection-menu-option__label')?.textContent)).toEqual(['撤销', '重做', '剪切', '复制', '粘贴', '全选', '引用到对话'])
    expect(f.root.querySelectorAll('hr')).toHaveLength(2)
    const style = (f.root.querySelector('[role="menu"]') as HTMLElement).style
    expect(style.width).toBe('var(--buddy-menu-width, 12.5rem)')
    expect(style.maxWidth).toContain('--buddy-menu-max-width')
    buttons.find(button => button.textContent?.startsWith('复制'))!.click()
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith('copy'))
    expect(restore).toHaveBeenCalledOnce()
    expect(f.content.value.resourceQuotes).toBeUndefined()
  })

  it('keeps the full split target label without a native hover tooltip even when only one target is writable', async () => {
    const f = await mount('menu')
    f.host.options.isSplit = () => true
    const targets = f.host.options.targets()
    targets[0]!.label = `分屏 1 · ${'这是很长的对话标题'.repeat(20)}`
    f.host.options.targets = () => targets
    f.menu.open(quote, 10, 20)
    await nextTick()
    expect(f.root.textContent).toContain('引用到「分屏 1')
    expect(f.root.textContent).not.toContain('引用到对话')
    expect(f.root.querySelector('.resource-selection-menu-option__label')?.textContent).toBe(`引用到「${targets[0]!.label}」`)
    expect(f.root.querySelector('[title]')).toBeNull()
    f.root.querySelector('button')!.click()
    await nextTick()
    expect(f.content.value.resourceQuotes).toEqual([quote])
  })

  it('rejects editing after the source identity changes', async () => {
    const f = await mount('menu')
    const execute = vi.fn(async () => {})
    f.host.options.editSelection = execute
    f.menu.prepare(quote, 10, 20, false, { restore: () => true })!()
    await nextTick()
    f.host.options.source = () => ({ identity: 'changed', owner: null })
    f.root.querySelector('button')!.click()
    await nextTick()
    expect(execute).not.toHaveBeenCalled()
    expect(feedback.warning).toHaveBeenLastCalledWith('目标或来源已切换，请重新选择。')
  })

  it('closes the component menu when its source switches or unmounts', async () => {
    const f = await mount('menu')
    f.menu.open(quote, 10, 20)
    await nextTick()
    f.ownerKey.value = 'file:two'
    await nextTick()
    expect(f.root.querySelector('[role="menu"]')).toBeNull()
    f.unmount()
    expect(f.content.value.resourceQuotes).toBeUndefined()
  })

  it('rejects a prepared menu operation when the source view switches', async () => {
    const f = await mount('menu')
    const show = f.menu.prepare(quote, 10, 20)!
    f.ownerKey.value = 'file:two'
    await nextTick()
    show()
    await nextTick()
    expect(f.root.querySelector('[role="menu"]')).toBeNull()
    expect(f.content.value.resourceQuotes).toBeUndefined()
    expect(feedback.warning).toHaveBeenCalled()
  })

  it('reports an unavailable source as a changed operation rather than a size limit', async () => {
    const f = await mount('menu')
    f.host.options.source = () => null
    f.menu.open(quote, 10, 20)
    expect(feedback.warning).toHaveBeenLastCalledWith('目标或来源已切换，请重新选择。')
  })

  it('shows source, excerpt and safe full preview with removal, but no comment input', async () => {
    const f = await mount('strip')
    expect(f.root.textContent).toContain('auth.ts · L24–38')
    expect(f.root.querySelector('pre')!.textContent).toBe(quote.text)
    expect(f.root.querySelector('script')).toBeNull()
    expect(f.root.querySelector('input, textarea')).toBeNull()
    f.root.querySelector<HTMLButtonElement>('[aria-label="移除引用"]')!.click()
    expect(f.remove).toHaveBeenCalledWith('q')
    Array.from(f.root.querySelectorAll('button')).find(button => button.textContent === '定位来源')!.click()
    await nextTick()
    expect(f.locate).toHaveBeenCalledWith(quote)
    expect(feedback.info).toHaveBeenCalledWith('来源已不可用，引用内容仍保留。')
    expect(f.root.querySelector('pre')!.textContent).toBe(quote.text)
  })

  it('renders a safe artifact excerpt with its artifact label and original path', async () => {
    const snapshot = { ...artifactQuote, text: '<script>Do not execute</script>\nFrozen artifact text' }
    const f = await mount('strip', true, snapshot)
    expect(f.root.textContent).toContain('本轮产出 · report.md')
    expect(f.root.querySelector('.resource-quote-preview__path')?.textContent).toContain(artifactQuote.source.path)
    expect(f.root.querySelector('pre')!.textContent).toBe(snapshot.text)
    expect(f.root.querySelector('script')).toBeNull()
    f.root.querySelector<HTMLButtonElement>('[aria-label="移除引用"]')!.click()
    expect(f.remove).toHaveBeenCalledWith(snapshot.id)
  })

  it('does not show removal in sent-message history', async () => {
    const f = await mount('strip', false)
    expect(f.root.querySelector('[aria-label="移除引用"]')).toBeNull()
    expect(f.root.querySelector('pre')!.textContent).toBe(quote.text)
  })
})

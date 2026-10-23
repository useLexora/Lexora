// @vitest-environment jsdom
import type { BuddyComposerDirectory } from '@buddy-shared/conversation/composerResource'
import type { ChatPromptContextOption } from '@/modules/prompt-input'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, shallowRef } from 'vue'
import ChatComposerSourcePicker from '../ChatComposerSourcePicker.vue'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

describe('composer source picker', () => {
  it('distinguishes same-name plugin skill sources and selects their stable references', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const selected: string[] = []
    const options = shallowRef<ChatPromptContextOption[]>(['publisher-one.tables', 'publisher-two.tables'].map(id => ({
      kind: 'skill',
      label: 'tables:review',
      value: 'tables:review',
      path: null,
      description: `Tables · ${id}\nReview a workbook`,
      skillScope: 'global',
      skillPlugin: { extensionId: id, extensionName: 'Tables' },
      skill: { id, name: 'tables:review', revision: id },
    })))
    const app = createApp(defineComponent({ setup: () => () => h(ChatComposerSourcePicker, {
      activeIndex: 0,
      accessibleLabel: 'Skills',
      emptyLabel: 'Empty',
      language: 'zh-CN',
      loadingLabel: 'Loading',
      options: options.value,
      onSelect: option => selected.push(option.skill!.id),
    }) }))
    app.mount(root)
    cleanups.push(() => {
      app.unmount()
      root.remove()
    })
    await nextTick()
    expect(root.querySelectorAll('[role="option"]')).toHaveLength(2)
    expect(root.textContent).toContain('publisher-one.tables')
    expect(root.textContent).toContain('publisher-two.tables')
    options.value = [...options.value].reverse()
    await nextTick()
    for (const option of root.querySelectorAll<HTMLElement>('[role="option"]'))
      option.click()
    expect(selected).toEqual(['publisher-two.tables', 'publisher-one.tables'])
  })

  it('keeps directory availability and empty states separate from historical inputs', async () => {
    const root = document.createElement('div')
    root.className = 'buddy-app'
    document.body.append(root)
    const directory = shallowRef<BuddyComposerDirectory>()
    const options = shallowRef<ChatPromptContextOption[]>([{ category: 'history', kind: 'file', label: 'image.png', value: 'historical-image', description: null, path: null }])
    const app = createApp(defineComponent({
      setup: () => () => h(ChatComposerSourcePicker, { activeIndex: 0, accessibleLabel: 'References', emptyLabel: '暂无可引用内容', language: 'zh-CN', loadingLabel: 'Loading', options: options.value, directory: directory.value }),
    }))
    app.mount(root)
    cleanups.push(() => {
      app.unmount()
      root.remove()
    })
    await nextTick()
    expect(root.textContent).toContain('历史输入')
    expect(root.textContent).not.toContain('当前工作目录')
    expect(root.querySelector('[role="switch"]')).toBeNull()
    directory.value = { workingDirectory: '/work', path: '/work', query: '', status: 'ready', hasMore: false }
    await nextTick()
    expect(root.textContent).toContain('当前工作目录')
    expect(root.textContent).toContain('此目录为空')
    expect(root.querySelector('[role="option"]')?.textContent).toContain('image.png')
    expect(root.querySelector('[role="switch"]')).not.toBeNull()
    directory.value = { ...directory.value, query: 'image' }
    await nextTick()
    expect(root.textContent).toContain('没有匹配的内容')
    expect(root.textContent).not.toContain('此目录为空')
    directory.value = { ...directory.value, status: 'unavailable' }
    await nextTick()
    expect(root.textContent).toContain('无法读取此目录')
    expect(root.textContent).not.toContain('没有匹配的内容')
    expect(root.querySelector('[role="option"]')?.textContent).toContain('image.png')
    directory.value = { ...directory.value, query: '', status: 'ready' }
    options.value = []
    await nextTick()
    expect(root.textContent).toContain('此目录为空')
    directory.value = undefined
    await nextTick()
    expect(root.textContent).toContain('暂无可引用内容')
    expect(root.textContent).not.toContain('当前工作目录')
  })

  it('shares pointer and keyboard highlight, separates directory entry from selection and retains focus', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const input = document.createElement('textarea')
    document.body.append(input)
    const activeIndex = shallowRef(0)
    const options: ChatPromptContextOption[] = ['src', 'assets'].map(name => ({
      category: 'space',
      description: '/work · redundant',
      entryKind: 'directory',
      kind: 'file',
      label: name,
      path: `/work/${name}`,
      source: { bindingId: 'binding', relativePath: name, spaceId: 'space' },
      value: name,
    }))
    const selected: string[] = []
    const entered: string[] = []
    const app = createApp(defineComponent({
      setup: () => () => h(ChatComposerSourcePicker, {
        activeIndex: activeIndex.value,
        accessibleLabel: 'References',
        emptyLabel: 'Empty',
        language: 'zh-CN',
        loadingLabel: 'Loading',
        options,
        onHighlight: index => activeIndex.value = index,
        onSelect: option => selected.push(option.value),
        onEnterDirectory: option => entered.push(option.path!),
      }),
    }))
    app.mount(root)
    cleanups.push(() => {
      app.unmount()
      root.remove()
      input.remove()
    })
    await nextTick()
    input.focus()
    const rows = root.querySelectorAll('.chat-composer-source-picker__row')
    rows[1]!.dispatchEvent(new Event('pointermove', { bubbles: true }))
    await nextTick()
    expect(root.querySelector('[aria-selected="true"]')?.textContent).toContain('assets')
    const enter = rows[1]!.querySelector<HTMLButtonElement>('.chat-composer-source-picker__enter')!
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    enter.dispatchEvent(down)
    enter.click()
    expect(down.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(input)
    expect(entered).toEqual(['/work/assets'])
    expect(selected).toEqual([])
    activeIndex.value = 0
    await nextTick()
    rows[0]!.querySelector<HTMLButtonElement>('[role="option"]')!.click()
    expect(selected).toEqual(['src'])
  })
})

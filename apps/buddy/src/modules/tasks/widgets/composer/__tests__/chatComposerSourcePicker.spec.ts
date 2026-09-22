// @vitest-environment jsdom
import type { BuddyComposerDirectory } from '@buddy-shared/conversation/composerResource'
import type { ChatPromptContextOption } from '@/modules/prompt-input'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, shallowRef } from 'vue'
import ChatComposerSourcePicker from '../ChatComposerSourcePicker.vue'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

describe('composer source picker', () => {
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
    expect(root.querySelectorAll('.chat-composer-source-picker__empty')).toHaveLength(1)
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
    expect(root.querySelector('.chat-composer-source-picker__root')?.textContent).toBe('/work')
    expect([...root.querySelectorAll('small')].map(item => item.textContent)).toEqual(['目录', '目录'])
    const rows = root.querySelectorAll('.chat-composer-source-picker__row')
    rows[1]!.dispatchEvent(new Event('pointermove', { bubbles: true }))
    await nextTick()
    expect(root.querySelector('[aria-selected="true"]')?.textContent).toContain('assets')
    expect(root.querySelectorAll('.is-active')).toHaveLength(1)
    const enter = rows[1]!.querySelector<HTMLButtonElement>('.chat-composer-source-picker__enter')!
    expect(enter.closest('[role="option"]')).toBeNull()
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
    expect(root.querySelectorAll('.chat-composer-source-picker__footer')).toHaveLength(1)
  })

  it('renders skill icons and scope tags for directory, space and global skills', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const options: ChatPromptContextOption[] = [
      {
        description: 'Local project skill',
        kind: 'skill',
        label: 'project-analyzer',
        path: null,
        skillScope: 'directory',
        value: 'project-analyzer',
      },
      {
        description: 'Space installed skill',
        kind: 'skill',
        label: 'space-helper',
        path: null,
        skillScope: 'space',
        value: 'space-helper',
      },
      {
        description: 'Global skill',
        kind: 'skill',
        label: 'global-bot',
        path: null,
        skillScope: 'global',
        value: 'global-bot',
      },
    ]
    const app = createApp(defineComponent({
      setup: () => () => h(ChatComposerSourcePicker, {
        accessibleLabel: 'Skills',
        emptyLabel: 'No skills',
        language: 'zh-CN',
        loadingLabel: 'Loading',
        options,
      }, {
        extra: () => h('button', { class: 'custom-extra' }, 'Manage'),
      }),
    }))
    app.mount(root)
    cleanups.push(() => {
      app.unmount()
      root.remove()
    })
    await nextTick()

    const kindIcons = root.querySelectorAll('.chat-composer-source-picker__kind')
    expect(kindIcons).toHaveLength(3)
    kindIcons.forEach((icon) => {
      expect(icon.classList.contains('is-skill')).toBe(true)
      expect(icon.textContent?.trim()).not.toBe('$')
      expect(icon.querySelector('svg')).not.toBeNull()
    })

    const scopes = root.querySelectorAll('.chat-composer-source-picker__scope')
    expect(scopes).toHaveLength(3)
    expect(scopes[0]?.textContent).toBe('工作目录')
    expect(scopes[0]?.classList.contains('is-directory')).toBe(true)
    expect(scopes[1]?.textContent).toBe('空间')
    expect(scopes[1]?.classList.contains('is-space')).toBe(true)
    expect(scopes[2]?.textContent).toBe('全局')
    expect(scopes[2]?.classList.contains('is-global')).toBe(true)

    expect(root.querySelector('.custom-extra')?.textContent).toBe('Manage')
  })
})

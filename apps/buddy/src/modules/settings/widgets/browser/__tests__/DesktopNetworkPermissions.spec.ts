// @vitest-environment jsdom
import type { NetworkPermissions } from '@buddy-shared/permissions/networkPermissions'
import { DEFAULT_NETWORK_PERMISSIONS, networkPermissionsSchema } from '@buddy-shared/permissions/networkPermissions'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import DesktopNetworkPermissions from '../DesktopNetworkPermissions.vue'

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  vi.unstubAllGlobals()
})

function mount(initial: NetworkPermissions = structuredClone(DEFAULT_NETWORK_PERMISSIONS)) {
  const scrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value() {} })
  cleanups.push(() => {
    if (scrollTo)
      Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollTo)
    else
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
  })
  const saved = shallowRef(initial)
  const pending = shallowRef(false)
  let succeeds = true
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({
    render: () => h(DesktopNetworkPermissions, {
      value: saved.value,
      language: 'zh-CN',
      pending: pending.value,
      save: async (value) => {
        pending.value = true
        await nextTick()
        if (succeeds)
          saved.value = value
        pending.value = false
        return succeeds
      },
    }),
  })
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  return {
    root,
    saved,
    pending,
    succeed: (value: boolean) => {
      succeeds = value
    },
  }
}

function button(root: ParentNode, label: string) {
  const found = Array.from(root.querySelectorAll('button')).find(element => (element.getAttribute('aria-label') || element.textContent?.trim()) === label)
  expect(found, label).toBeTruthy()
  return found!
}

function dialog() {
  const form = document.querySelector<HTMLElement>('[data-testid="network-rule-dialog"] form')
  expect(form).toBeTruthy()
  return form!
}

async function input(element: HTMLInputElement, value: string) {
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

async function choose(root: ParentNode, label: string, value: string) {
  const control = Array.from(root.querySelectorAll<HTMLElement>('.n-select')).find(element =>
    element.getAttribute('aria-labelledby')?.split(' ').map(id => document.getElementById(id)?.textContent?.trim()).join(' ') === label,
  )
  expect(control, label).toBeTruthy()
  await vi.waitFor(() => expect(control!.querySelector('.n-base-selection--disabled')).toBeNull())
  control!.querySelector<HTMLElement>('.n-base-selection')!.click()
  await nextTick()
  const options = () => Array.from(document.querySelectorAll<HTMLElement>('.n-base-select-option')).filter(element => !element.closest('[style*="display: none"]'))
  await vi.waitFor(() => expect(options()).toHaveLength(3))
  const option = options().find(element => element.textContent?.trim() === value)
  expect(option, value).toBeTruthy()
  option!.click()
  await nextTick()
}

async function submit() {
  dialog().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await nextTick()
}

async function open(root: ParentNode) {
  button(root, '添加规则').click()
  await nextTick()
  return dialog()
}

async function preview(root: ParentNode) {
  button(root, '测试域名匹配').click()
  await nextTick()
  return document.querySelector<HTMLElement>('[data-testid="network-permission-preview"]')!
}

async function action(root: ParentNode, label: string) {
  button(root, '规则操作').click()
  await nextTick()
  const option = Array.from(document.querySelectorAll<HTMLElement>('.n-dropdown-option-body')).find(element => element.textContent?.trim() === label)
  expect(option, label).toBeTruthy()
  option!.click()
  await nextTick()
}

describe('domain permission settings', () => {
  it('uses the same table for defaults and rules and saves each operation independently', async () => {
    const { root, saved } = mount(networkPermissionsSchema.parse({
      ...DEFAULT_NETWORK_PERMISSIONS,
      rules: [{ id: 'site', pattern: 'example.com', match: 'exact', access: 'allow', download: 'ask', upload: 'ask' }],
    }))
    const rows = root.querySelectorAll('tbody tr')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('默认权限')
    expect(rows[1]?.textContent).toContain('example.com')
    await choose(rows[0]!, '默认权限 访问网站', '始终拒绝')
    await vi.waitFor(() => expect(saved.value.defaults).toEqual({ access: 'deny', download: 'ask', upload: 'ask' }))
    await choose(rows[1]!, 'example.com 下载文件', '始终拒绝')
    await vi.waitFor(() => expect(saved.value.rules[0]).toMatchObject({ access: 'allow', download: 'deny', upload: 'ask' }))
  })

  it('discards a cancelled modal draft and initially exposes only the host and access decision', async () => {
    const { root, saved } = mount()
    const form = await open(root)
    expect(form.querySelectorAll('.n-select')).toHaveLength(1)
    await input(form.querySelector('input')!, 'example.com')
    button(form, '取消').click()
    await vi.waitFor(() => expect(document.querySelector('[data-testid="network-rule-dialog"]')).toBeNull())
    expect(saved.value).toEqual(DEFAULT_NETWORK_PERMISSIONS)
  })

  it('validates advanced regex syntax and previews the rule before saving', async () => {
    const { root, saved } = mount()
    const form = await open(root)
    button(form, '更多选项').click()
    await nextTick()
    await choose(form, '匹配方式', '正则（高级）')
    const pattern = form.querySelector<HTMLInputElement>('input')!
    await input(pattern, '(?=evil)evil')
    expect(form.textContent).toContain('正则无效')
    button(form, '支持的正则语法').click()
    await nextTick()
    expect(document.body.textContent).toContain('采用非回溯匹配')
    button(form, '支持的正则语法').click()
    await nextTick()
    expect(button(form, '保存规则').disabled).toBe(true)
    await input(pattern, '([a-z]+\\.)?example\\.com')
    const match = await preview(form)
    await input(match.querySelector('input')!, 'api.example.com')
    expect(match.textContent).toContain('命中规则')
    expect(saved.value.rules).toEqual([])
    button(match, '关闭').click()
    await vi.waitFor(() => expect(document.querySelector('[data-testid="network-permission-preview"]')).toBeNull())
    expect(pattern.value).toBe('([a-z]+\\.)?example\\.com')
    await submit()
    await vi.waitFor(() => expect(saved.value.rules[0]?.match).toBe('regex'))
    expect(saved.value.rules[0]?.pattern).toBe('([a-z]+\\.)?example\\.com')
  })

  it('keeps failed edits and commits add/edit/delete without optimistic mutation', async () => {
    const { root, saved, succeed } = mount()
    expect(root.textContent).toContain('对所有任务生效')
    const form = await open(root)
    expect(button(form, '保存规则').disabled).toBe(true)
    const pattern = form.querySelector<HTMLInputElement>('input')!
    await input(pattern, 'https://example.com/path')
    expect(form.querySelector('[role="alert"]')?.textContent).toContain('不要包含协议')
    await submit()
    expect(saved.value.rules).toEqual([])
    await input(pattern, 'EXAMPLE.COM.')
    succeed(false)
    await submit()
    await vi.waitFor(() => expect(form.textContent).toContain('域名权限未能保存'))
    expect(saved.value.rules).toEqual([])
    expect(pattern.value).toBe('EXAMPLE.COM.')
    succeed(true)
    await submit()
    await vi.waitFor(() => expect(document.querySelector('[data-testid="network-rule-dialog"]')).toBeNull())
    expect(saved.value.rules).toEqual([expect.objectContaining({ pattern: 'example.com', access: 'ask', download: 'ask', upload: 'ask' })])

    await action(root, '编辑规则')
    await input(dialog().querySelector<HTMLInputElement>('input')!, 'api.example.com')
    await submit()
    await vi.waitFor(() => expect(document.querySelector('[data-testid="network-rule-dialog"]')).toBeNull())
    expect(saved.value.rules[0]?.pattern).toBe('api.example.com')
    button(root, '删除规则').click()
    await vi.waitFor(() => expect(saved.value.rules).toEqual([]))
    expect(root.querySelectorAll('tbody tr')).toHaveLength(1)
  })

  it('rejects duplicates and merges the draft with the latest saved defaults and other rules', async () => {
    const { root, saved } = mount(networkPermissionsSchema.parse({
      ...DEFAULT_NETWORK_PERMISSIONS,
      rules: [{ id: 'site', pattern: 'example.com', match: 'exact', access: 'allow', download: 'deny', upload: 'ask' }],
    }))
    const form = await open(root)
    const pattern = form.querySelector<HTMLInputElement>('input')!
    await input(pattern, 'EXAMPLE.COM.')
    expect(form.textContent).toContain('已存在相同匹配方式')
    expect(button(form, '保存规则').disabled).toBe(true)
    await input(pattern, 'new.example')
    saved.value = { ...saved.value, defaults: { access: 'deny', download: 'deny', upload: 'deny' } }
    await nextTick()
    expect(pattern.value).toBe('new.example')
    await submit()
    await vi.waitFor(() => expect(saved.value.rules).toHaveLength(2))
    expect(saved.value.defaults).toEqual({ access: 'deny', download: 'deny', upload: 'deny' })
    expect(saved.value.rules[1]).toMatchObject({ access: 'ask', download: 'ask', upload: 'ask' })
  })

  it('previews saved matches, updates with settings changes, and rejects URL inputs', async () => {
    const { root, saved } = mount(networkPermissionsSchema.parse({
      ...DEFAULT_NETWORK_PERMISSIONS,
      rules: [{ id: 'site', pattern: 'example.com', match: 'subdomains', access: 'allow', download: 'deny', upload: 'ask' }],
    }))
    const match = await preview(root)
    const host = match.querySelector('input')!
    await input(host, 'API.EXAMPLE.COM.')
    expect(match.textContent).toContain('api.example.com')
    expect(match.textContent).toContain('命中规则：example.com')
    expect(match.textContent).toContain('始终允许')
    expect(match.textContent).toContain('始终拒绝')
    expect(match.textContent).toContain('需要批准')
    saved.value = structuredClone(DEFAULT_NETWORK_PERMISSIONS)
    await nextTick()
    expect(match.textContent).toContain('使用默认权限')
    await input(host, 'https://example.com/private')
    expect(match.querySelector('[role="alert"]')?.textContent).toContain('不要包含协议')
    expect(match.querySelector('[role="status"]')).toBeNull()
    button(match, '关闭').click()
    await vi.waitFor(() => expect(document.querySelector('[data-testid="network-permission-preview"]')).toBeNull())
    expect(saved.value).toEqual(DEFAULT_NETWORK_PERMISSIONS)
  })

  it('retains the original order on failed movement and saves a successful reorder', async () => {
    const { root, saved, succeed } = mount(networkPermissionsSchema.parse({
      ...DEFAULT_NETWORK_PERMISSIONS,
      rules: [
        { id: 'first', pattern: '.*', match: 'regex', access: 'deny', download: 'ask', upload: 'ask' },
        { id: 'second', pattern: '.*\\.example', match: 'regex', access: 'allow', download: 'ask', upload: 'ask' },
      ],
    }))
    succeed(false)
    await action(root, '下移')
    await vi.waitFor(() => expect(root.textContent).toContain('域名权限未能保存'))
    expect(saved.value.rules.map(rule => rule.id)).toEqual(['first', 'second'])
    succeed(true)
    await action(root, '下移')
    await vi.waitFor(() => expect(saved.value.rules.map(rule => rule.id)).toEqual(['second', 'first']))
  })
})

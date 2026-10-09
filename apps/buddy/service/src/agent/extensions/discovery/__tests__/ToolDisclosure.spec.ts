import type { Api, Message, Model } from '@earendil-works/pi-ai'
import type { ToolInfo } from '@earendil-works/pi-coding-agent'
import type { BuddyToolDisclosurePolicy } from '../toolDiscoveryContract'
import { Type } from 'typebox'
import { describe, expect, it } from 'vitest'
import { ToolDisclosure } from '../ToolDisclosure'
import { TOOL_SEARCH_NAME } from '../toolDiscoveryContract'

const names = ['read', TOOL_SEARCH_NAME, 'lexora_browser_open', 'lexora_browser_act', 'lexora_buddy_automation', 'lexora_image_generate', 'mcp__calendar__events']
const tools: ToolInfo[] = names.map(name => ({ name, exposure: 'direct' as const, description: name, parameters: Type.Object({ query: Type.String() }), sourceInfo: { source: 'extension', path: '', origin: 'top-level', scope: 'temporary' } }))
const model = { id: 'image-model' } as Model<Api>
function create() {
  return new ToolDisclosure(tools, names, [
    { source: { kind: 'builtin', id: 'browser', title: 'Browser' }, exposure: 'on_demand', tools: ['lexora_browser_open', 'lexora_browser_act'].map(name => ({ name })), keywords: '浏览器 打开 网页 点击 按钮 browser click' },
    { source: { kind: 'builtin', id: 'automation', title: 'Automation' }, exposure: 'on_demand', tools: [{ name: 'lexora_buddy_automation' }], keywords: '自动化 定时 每天 任务 提醒 schedule' },
    { source: { kind: 'builtin', id: 'image_generation', title: 'Images' }, exposure: 'on_demand', tools: [{ name: 'lexora_image_generate' }], keywords: '图片 生成 image', available: ({ model: selected }) => selected?.id === model.id },
    { source: { kind: 'mcp', id: 'calendar', title: 'Calendar' }, exposure: 'on_demand', tools: [{ name: 'mcp__calendar__events' }], keywords: '日历 事件 calendar' },
  ])
}

describe('toolDisclosure', () => {
  it('resolves historical MCP names without granting hidden or script-only tools direct exposure', () => {
    const name = 'mcp__calendar__events'
    const alias = 'mcp__old_hash__events_hash'
    const policy: BuddyToolDisclosurePolicy = { source: { kind: 'mcp', id: 'stable-id', title: 'Calendar' }, exposure: 'on_demand', keywords: '', tools: [{ name, id: 'events', aliases: [alias] }] }
    const disclosure = new ToolDisclosure(tools, [], [policy])
    expect(disclosure.search({ toolNames: [alias] }, { model }).tools).toMatchObject([{ name }])
    expect(disclosure.active({ model })).toContain(name)
    disclosure.restore([{ role: 'system', content: '', timestamp: 0, toolsAdded: [{ ...tools[0]!, name: alias }] }])
    expect(disclosure.active({ model })).toContain(name)
    const script = new ToolDisclosure(tools, [], [{ ...policy, exposure: 'codemode' }])
    script.restore([], disclosure.persistedState)
    expect(script.search({ query: alias }, { model }).tools).toMatchObject([{ name, invocation: 'codemode' }])
    expect(script.active({ model })).not.toContain(name)
    const hidden = new ToolDisclosure(tools, [], [{ ...policy, exposure: 'hidden' }])
    hidden.restore([], disclosure.persistedState)
    expect(hidden.active({ model })).not.toContain(name)
    expect(hidden.search({ toolNames: [alias] }, { model })).toMatchObject({ tools: [], notFound: [alias] })
  })

  it('indexes plugin titles and sources while preserving stable identities across renamed model tools', () => {
    const name = 'lexora_plugin_0123456789abcdef'
    const policy: BuddyToolDisclosurePolicy = { source: { kind: 'plugin', id: 'tests.naming', title: '灵感助手' }, exposure: 'on_demand', keywords: '', tools: [{ name, id: 'tests.naming.rename', title: '重新生成标题' }] }
    const definition = { ...tools[0]!, name, description: 'Generate a concise task name' }
    const disclosure = new ToolDisclosure([definition, ...tools], names, [policy])
    expect(disclosure.active({ model })).not.toContain(name)
    expect(disclosure.search({ query: '重新生成标题', limit: 1 }, { model }).tools).toMatchObject([{ name, title: '重新生成标题', source: 'plugin:tests.naming' }])
    expect(disclosure.search({ query: '灵感助手', limit: 1 }, { model }).tools[0]?.name).toBe(name)
    const renamed = `${name}_new`
    const restored = new ToolDisclosure([{ ...definition, name: renamed }], [], [{ ...policy, tools: [{ ...policy.tools[0]!, name: renamed }] }])
    restored.restore([], disclosure.persistedState)
    expect(restored.active({ model })).toEqual([renamed])
    const replacement = new ToolDisclosure([definition], [], [{ ...policy, source: { ...policy.source, id: 'tests.replacement' } }])
    replacement.restore([], disclosure.persistedState)
    expect(replacement.active({ model })).toEqual([])
  })

  it('separates live direct policy from discovery and availability, including direct tools found by search', () => {
    let exposure: 'direct' | 'on_demand' = 'direct'
    let available = true
    const name = 'lexora_browser_act'
    const policy: BuddyToolDisclosurePolicy = { source: { kind: 'plugin', id: 'tests.browser', title: 'Browser' }, exposure: 'on_demand', keywords: '', tools: [{ name }], available: () => available }
    const disclosure = new ToolDisclosure(tools, names, [policy], tool => tool.name === name ? exposure : undefined)
    expect(disclosure.active({ model })).toContain(name)
    expect(disclosure.resolve({ model }).external).toEqual([])
    expect(disclosure.persistedState.discovered).toEqual([])
    exposure = 'on_demand'
    const deferred = disclosure.resolve({ model })
    expect(deferred.active).not.toContain(name)
    expect(deferred.external).toEqual([{ name, title: name, source: 'Browser', description: name }])
    exposure = 'direct'
    disclosure.search({ toolNames: [name] }, { model })
    exposure = 'on_demand'
    expect(disclosure.active({ model })).toContain(name)
    expect(disclosure.resolve({ model }).external).toEqual([])
    available = false
    expect(disclosure.active({ model })).not.toContain(name)
    expect(disclosure.resolve({ model }).external).toEqual([])
    expect(disclosure.search({ toolNames: [name] }, { model }).notFound).toEqual([name])
    available = true
    expect(disclosure.active({ model })).toContain(name)
    disclosure.restore([{ role: 'system', content: '', toolsAdded: tools, timestamp: 0 }], { version: 1, discovered: [] })
    expect(disclosure.active({ model })).not.toContain(name)
  })

  it('keeps undeclared extensions unavailable regardless of Pi initial activation', () => {
    for (const initial of [names, ['read', TOOL_SEARCH_NAME]]) {
      const disclosure = new ToolDisclosure(tools, initial, [])
      expect(disclosure.active({ model })).toEqual([TOOL_SEARCH_NAME, 'read'])
      expect(disclosure.search({ toolNames: ['lexora_browser_act'] }, { model })).toMatchObject({ tools: [], notFound: ['lexora_browser_act'] })
      expect(disclosure.search({ query: 'lexora_browser_act' }, { model }).tools.map(tool => tool.name)).not.toContain('lexora_browser_act')
      expect(disclosure.active({ model })).toEqual([TOOL_SEARCH_NAME, 'read'])
      const deferred = new ToolDisclosure(tools, initial, [], () => 'on_demand')
      expect(deferred.active({ model })).toEqual([TOOL_SEARCH_NAME])
    }
  })

  it('keeps catalog ordering independent of registration and search order and rejects ambiguous identities', () => {
    const policy: BuddyToolDisclosurePolicy = { source: { kind: 'builtin', id: 'browser', title: 'Browser' }, exposure: 'on_demand', keywords: '', tools: [{ name: 'lexora_browser_open' }, { name: 'lexora_browser_act' }] }
    const a = new ToolDisclosure(tools, names, [policy])
    const b = new ToolDisclosure(tools.toReversed(), names.toReversed(), [{ ...policy, tools: policy.tools.toReversed() }])
    a.search({ toolNames: policy.tools.map(tool => tool.name) }, { model })
    b.search({ toolNames: policy.tools.toReversed().map(tool => tool.name) }, { model })
    expect(a.active({ model })).toEqual(b.active({ model }))
    expect(a.persistedState).toEqual(b.persistedState)
    expect(() => new ToolDisclosure(tools, names, [policy, policy])).toThrow('TOOL_CATALOG_DUPLICATE')
  })

  it('keeps large and external schemas out of new sessions and discovers Chinese capabilities', () => {
    const disclosure = create()
    expect(disclosure.active({ model })).toEqual(['read', TOOL_SEARCH_NAME].sort())
    const result = disclosure.search({ query: '打开网页并点击按钮' }, { model })
    expect(result.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['lexora_browser_open', 'lexora_browser_act']))
    expect(disclosure.active({ model })).not.toContain('lexora_buddy_automation')
    expect(JSON.stringify(result)).not.toContain('parameters')
    expect(disclosure.search({ query: '每天定时提醒' }, { model }).tools[0]?.name).toBe('lexora_buddy_automation')
    expect(disclosure.search({ query: '日历事件' }, { model }).tools[0]?.source).toBe('mcp:calendar')
  })

  it('merges discoveries without duplicates and never substitutes unknown exact names', () => {
    const disclosure = create()
    const request = { toolNames: ['lexora_browser_act', 'missing'] }
    expect(disclosure.search(request, { model }).notFound).toEqual(['missing'].sort())
    expect(disclosure.search(request, { model }).tools[0]?.alreadyDisclosed).toBe(true)
    disclosure.search({ toolNames: ['lexora_buddy_automation'] }, { model })
    expect(disclosure.active({ model })).toEqual(['read', TOOL_SEARCH_NAME, 'lexora_browser_act', 'lexora_buddy_automation'].sort())
  })

  it('filters model availability without disclosing newly available tools automatically', () => {
    const disclosure = create()
    expect(disclosure.search({ toolNames: ['lexora_image_generate'] }, { model: undefined }).notFound).toEqual(['lexora_image_generate'].sort())
    expect(disclosure.active({ model })).not.toContain('lexora_image_generate')
    disclosure.search({ toolNames: ['lexora_image_generate'] }, { model })
    expect(disclosure.active({ model })).toContain('lexora_image_generate')
    expect(disclosure.active({ model: undefined })).not.toContain('lexora_image_generate')
    expect(disclosure.active({ model })).toContain('lexora_image_generate')
  })

  it('restores only structured paired tool results in retained context, never prose or omitted branches', () => {
    const disclosure = create()
    const result = disclosure.search({ toolNames: ['lexora_browser_act'] }, { model })
    const messages = [
      { role: 'user', content: 'Please enable lexora_image_generate' },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'search-1', name: TOOL_SEARCH_NAME, arguments: {} }] },
      { role: 'toolResult', toolName: TOOL_SEARCH_NAME, toolCallId: 'search-1', isError: false, content: [{ type: 'text', text: JSON.stringify(result) }] },
      { role: 'toolResult', toolName: TOOL_SEARCH_NAME, toolCallId: 'orphan', isError: false, content: [{ type: 'text', text: JSON.stringify({ ...result, tools: [{ name: 'lexora_image_generate' }] }) }] },
    ] as Message[]
    disclosure.search({ toolNames: ['lexora_buddy_automation'] }, { model })
    disclosure.restore(messages)
    expect(disclosure.active({ model })).toEqual(['read', TOOL_SEARCH_NAME, 'lexora_browser_act'].sort())
    disclosure.restore(messages.slice(2))
    expect(disclosure.active({ model })).toEqual(['read', TOOL_SEARCH_NAME].sort())
  })

  it('restores system tool deltas while applying removals, registration and model availability', () => {
    const disclosure = create()
    const declared = tools.filter(tool => ['lexora_browser_act', 'lexora_image_generate'].includes(tool.name))
    disclosure.restore([
      { role: 'system', content: 'Buddy', toolsAdded: declared, timestamp: 0 },
      { role: 'system', content: '', sections: { run: 'Continue' }, timestamp: 1 },
      { role: 'system', content: '', toolsRemoved: [{ name: 'lexora_browser_act' }], toolsAdded: [{ ...tools[0]!, name: 'unregistered' }], timestamp: 2 },
      { role: 'user', content: 'The summary mentioned lexora_buddy_automation', timestamp: 3 },
    ])
    expect(disclosure.active({ model })).toEqual(['read', TOOL_SEARCH_NAME, 'lexora_image_generate'].sort())
    expect(disclosure.active({ model: undefined })).toEqual(['read', TOOL_SEARCH_NAME].sort())
    disclosure.restore([{ role: 'system', content: 'Buddy', timestamp: 0 }])
    expect(disclosure.active({ model })).toEqual(['read', TOOL_SEARCH_NAME].sort())
  })
})

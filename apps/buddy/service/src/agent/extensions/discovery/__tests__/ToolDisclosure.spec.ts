import type { Api, Message, Model } from '@earendil-works/pi-ai'
import type { ToolInfo } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { describe, expect, it } from 'vitest'
import { ToolDisclosure } from '../ToolDisclosure'
import { TOOL_SEARCH_NAME } from '../toolDiscoveryContract'

const names = ['read', TOOL_SEARCH_NAME, 'lexora_browser_open', 'lexora_browser_act', 'lexora_buddy_automation', 'lexora_image_generate', 'mcp__calendar__events']
const tools: ToolInfo[] = names.map(name => ({ name, description: name, parameters: Type.Object({ query: Type.String() }), sourceInfo: { source: 'extension', path: '', origin: 'top-level', scope: 'temporary' } }))
const model = { id: 'image-model' } as Model<Api>
function create() {
  return new ToolDisclosure(tools, names, [
    { group: 'browser', toolNames: ['lexora_browser_open', 'lexora_browser_act'], keywords: '浏览器 打开 网页 点击 按钮 browser click' },
    { group: 'automation', toolNames: ['lexora_buddy_automation'], keywords: '自动化 定时 每天 任务 提醒 schedule' },
    { group: 'image_generation', toolNames: ['lexora_image_generate'], keywords: '图片 生成 image', available: selected => selected?.id === model.id },
    { group: 'mcp', toolNames: ['mcp__calendar__events'], keywords: '日历 事件 calendar' },
  ])
}

describe('toolDisclosure', () => {
  it('does not activate registered tools outside the platform baseline or a disclosure policy', () => {
    const disclosure = new ToolDisclosure(tools, ['read', TOOL_SEARCH_NAME], [])
    expect(disclosure.search({ toolNames: ['lexora_browser_act'] }, model).notFound).toEqual(['lexora_browser_act'])
    expect(disclosure.search({ query: 'lexora_browser_act' }, model).tools.map(tool => tool.name)).not.toContain('lexora_browser_act')
    expect(disclosure.active(model)).toEqual(['read', TOOL_SEARCH_NAME])
  })

  it('keeps large and external schemas out of new sessions and discovers Chinese capabilities', () => {
    const disclosure = create()
    expect(disclosure.active(model)).toEqual(['read', TOOL_SEARCH_NAME])
    const result = disclosure.search({ query: '打开网页并点击按钮' }, model)
    expect(result.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['lexora_browser_open', 'lexora_browser_act']))
    expect(disclosure.active(model)).not.toContain('lexora_buddy_automation')
    expect(JSON.stringify(result)).not.toContain('parameters')
    expect(disclosure.search({ query: '每天定时提醒' }, model).tools[0]?.name).toBe('lexora_buddy_automation')
    expect(disclosure.search({ query: '日历事件' }, model).tools[0]?.source).toBe('mcp__calendar')
  })

  it('merges discoveries without duplicates and never substitutes unknown exact names', () => {
    const disclosure = create()
    const request = { toolNames: ['lexora_browser_act', 'missing'] }
    expect(disclosure.search(request, model).notFound).toEqual(['missing'])
    expect(disclosure.search(request, model).tools[0]?.alreadyDisclosed).toBe(true)
    disclosure.search({ toolNames: ['lexora_buddy_automation'] }, model)
    expect(disclosure.active(model)).toEqual(['read', TOOL_SEARCH_NAME, 'lexora_browser_act', 'lexora_buddy_automation'])
  })

  it('filters model availability without disclosing newly available tools automatically', () => {
    const disclosure = create()
    expect(disclosure.search({ toolNames: ['lexora_image_generate'] }, undefined).notFound).toEqual(['lexora_image_generate'])
    expect(disclosure.active(model)).not.toContain('lexora_image_generate')
    disclosure.search({ toolNames: ['lexora_image_generate'] }, model)
    expect(disclosure.active(model)).toContain('lexora_image_generate')
    expect(disclosure.active(undefined)).not.toContain('lexora_image_generate')
    expect(disclosure.active(model)).toContain('lexora_image_generate')
  })

  it('restores only structured paired tool results in retained context, never prose or omitted branches', () => {
    const disclosure = create()
    const result = disclosure.search({ toolNames: ['lexora_browser_act'] }, model)
    const messages = [
      { role: 'user', content: 'Please enable lexora_image_generate' },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'search-1', name: TOOL_SEARCH_NAME, arguments: {} }] },
      { role: 'toolResult', toolName: TOOL_SEARCH_NAME, toolCallId: 'search-1', isError: false, content: [{ type: 'text', text: JSON.stringify(result) }] },
      { role: 'toolResult', toolName: TOOL_SEARCH_NAME, toolCallId: 'orphan', isError: false, content: [{ type: 'text', text: JSON.stringify({ ...result, tools: [{ name: 'lexora_image_generate' }] }) }] },
    ] as Message[]
    disclosure.search({ toolNames: ['lexora_buddy_automation'] }, model)
    disclosure.restore(messages)
    expect(disclosure.active(model)).toEqual(['read', TOOL_SEARCH_NAME, 'lexora_browser_act'])
    disclosure.restore(messages.slice(2))
    expect(disclosure.active(model)).toEqual(['read', TOOL_SEARCH_NAME])
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
    expect(disclosure.active(model)).toEqual(['read', TOOL_SEARCH_NAME, 'lexora_image_generate'])
    expect(disclosure.active(undefined)).toEqual(['read', TOOL_SEARCH_NAME])
    disclosure.restore([{ role: 'system', content: 'Buddy', timestamp: 0 }])
    expect(disclosure.active(model)).toEqual(['read', TOOL_SEARCH_NAME])
  })
})

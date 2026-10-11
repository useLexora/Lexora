import type { Api, Model } from '@earendil-works/pi-ai'
import type { ToolInfo } from '@earendil-works/pi-coding-agent'
import type { BuddyToolDisclosurePolicy } from '../toolDiscoveryContract'
import { Type } from 'typebox'
import { describe, expect, it } from 'vitest'
import { toPiToolGroup } from '../../piToolGroup'
import { ToolDisclosure } from '../ToolDisclosure'
import { describeToolSearch } from '../toolDiscoveryExtension'

const model = {} as Model<Api>
const group = toPiToolGroup({ name: 'lexora_sample', description: 'Inspect and manage samples.', tools: [{ name: 'list' }, { name: 'get' }, { name: 'update' }] }, { update: 'lexora_legacy_update' })
const definitions: ToolInfo[] = [
  { name: 'read' },
  ...Object.values(group),
].map(tool => ({ ...tool, description: `Use ${tool.name}`, exposure: 'direct', parameters: Type.Object({ text: Type.String() }), sourceInfo: { source: 'extension', path: '', origin: 'top-level', scope: 'temporary' } }))
const policy: BuddyToolDisclosurePolicy = { source: { kind: 'builtin', id: 'sample', title: 'Samples' }, exposure: 'on_demand', keywords: '', tools: Object.values(group) }

describe('tool namespaces', () => {
  it('rejects duplicate definitions and runtime names before registration can replace a tool', () => {
    expect(() => toPiToolGroup({ name: 'lexora_sample', tools: [{ name: 'get' }, { name: 'get' }] })).toThrow('TOOL_GROUP_DUPLICATE')
    expect(() => toPiToolGroup({ name: 'lexora_sample', tools: [{ name: 'get' }, { name: 'update' }] }, { get: 'lexora_legacy_tool', update: 'lexora_legacy_tool' })).toThrow('TOOL_GROUP_DUPLICATE')
  })

  it('browses and pages members without loading them, then discovers only matching members', () => {
    const disclosure = new ToolDisclosure(definitions, ['read'], [policy])
    expect(disclosure.resolve({ model })).toMatchObject({ active: ['read'], catalog: { groups: [{ namespace: 'lexora_sample', source: 'builtin', toolCount: 3 }], tools: [] } })
    expect(disclosure.search({}, { model })).toMatchObject({ tools: [], candidates: [], groups: [{ namespace: 'lexora_sample', toolCount: 3 }] })
    const first = disclosure.search({ namespace: 'lexora_sample', limit: 2 }, { model })
    const second = disclosure.search({ namespace: 'lexora_sample', offset: first.nextOffset, limit: 2 }, { model })
    expect([...first.candidates, ...second.candidates].map(tool => tool.name)).toEqual([...Object.values(group).map(tool => tool.name)].sort())
    expect(second.nextOffset).toBeUndefined()
    expect(disclosure.persistedState.discovered).toEqual([])
    expect(disclosure.search({ namespace: 'lexora_sample', query: 'update', limit: 1 }, { model }).tools).toMatchObject([{ name: 'lexora_legacy_update', namespace: 'lexora_sample', source: 'builtin:sample' }])
    expect(disclosure.active({ model })).toEqual(['lexora_legacy_update', 'read'])
    expect(disclosure.search({ namespace: 'missing', toolNames: [group.list.name] }, { model }).notFound).toEqual([group.list.name])
  })

  it('keeps source ownership distinct and filters hidden or unavailable groups', () => {
    let available = true
    const external = { ...definitions[1]!, name: 'mcp__external__list' }
    const externalPolicy: BuddyToolDisclosurePolicy = { source: { kind: 'mcp', id: 'external', title: 'External' }, exposure: 'codemode', keywords: '', tools: [{ name: external.name }], available: () => available }
    const disclosure = new ToolDisclosure([...definitions, external], ['read'], [policy, externalPolicy])
    expect(disclosure.search({}, { model }).groups).toHaveLength(2)
    expect(disclosure.search({ namespace: 'lexora_sample', source: 'mcp:external', query: 'list' }, { model }).tools).toMatchObject([{ name: external.name, invocation: 'codemode' }])
    expect(disclosure.active({ model })).toEqual(['read'])
    available = false
    expect(disclosure.search({ source: 'mcp:external' }, { model }).groups).toEqual([])
    expect(disclosure.search({ namespace: 'lexora_sample', source: 'mcp:external' }, { model }).candidates).toEqual([])
    const hidden = new ToolDisclosure([...definitions, external], ['read'], [{ ...externalPolicy, exposure: 'hidden' }])
    available = true
    expect(hidden.search({}, { model }).groups).toEqual([])
    expect(hidden.resolve({ model }).catalog).toEqual({ groups: [], tools: [] })
  })

  it('preserves exact discovered identities when a group gains members or changes namespace', () => {
    const initial = new ToolDisclosure(definitions, ['read'], [policy])
    initial.search({ toolNames: [group.get.name] }, { model })
    const added = { ...definitions[1]!, name: 'lexora_sample_new' }
    const restored = new ToolDisclosure([...definitions, added].map(tool => tool.namespace ? { ...tool, namespace: { name: 'renamed_group' } } : tool), ['read'], [{ ...policy, tools: [...policy.tools, { name: added.name }] }])
    restored.restore([], initial.persistedState)
    expect(restored.active({ model })).toEqual([group.get.name, 'read'])
    expect(restored.search({ namespace: 'renamed_group' }, { model }).candidates).toHaveLength(4)
    expect(restored.persistedState).toEqual(initial.persistedState)
  })

  it('describes a large namespace once with bounded examples instead of copying its member schemas', () => {
    const tools = Array.from({ length: 100 }, (_, index) => ({ ...definitions[1]!, name: `mcp__catalog__tool_${index}`, description: `Capability ${index}`, parameters: Type.Object({ payload: Type.String({ description: 'PRIVATE_SCHEMA_BODY'.repeat(100) }) }) }))
    const disclosure = new ToolDisclosure(tools, [], [{ source: { kind: 'mcp', id: 'catalog', title: 'Catalog' }, exposure: 'on_demand', keywords: '', tools: tools.map(tool => ({ name: tool.name })) }])
    const text = describeToolSearch(disclosure.resolve({ model }).catalog)
    expect(text).toContain('"toolCount":100')
    expect(text).not.toContain('PRIVATE_SCHEMA_BODY')
    expect(text.match(/Capability \d+/g)).toHaveLength(2)
    expect(text).not.toContain('mcp__catalog__tool_')
    expect(text.length).toBeLessThan(1600)
    expect(disclosure.search({ namespace: 'lexora_sample', offset: 95, limit: 5 }, { model }).candidates).toHaveLength(5)
  })
})

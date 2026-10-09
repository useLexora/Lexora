import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { Tool } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import { createMcpTools } from '../createMcpTools'
import { createMcpToolName, McpToolNames } from '../mcpToolNames'
import { normalizeMcpResult } from '../mcpToolResults'

const tool: Tool = { name: 'lookup', inputSchema: { type: 'object', properties: {} } }
function create(annotations: Tool['annotations']) {
  return createMcpTools({
    serverId: 'stable-id',
    serverName: '日历',
    generation: 7,
    tools: [{ ...tool, annotations }],
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  })
}

describe('mCP adapter contracts', () => {
  it('keeps aliases bounded and distinguishes names normalized to the same slug', () => {
    const hashed = createMcpToolName('maps', 'foo-bar', name => name === 'mcp__maps__foo_bar')
    const remoteNames = ['foo-bar', 'foo_bar', 'FOO_BAR', '中文', 'a'.repeat(300), hashed.slice('mcp__maps__'.length)]
    const make = (names: string[]) => createMcpTools({ serverId: 'id', serverName: 'Maps', namespace: 'maps', generation: 1, tools: names.map(name => ({ ...tool, name })), callTool: async () => ({ content: [] }) }).tools.map(tool => tool.name)
    const names = make(remoteNames)
    expect(make([...remoteNames].reverse())).toEqual([...names].reverse())
    expect(createMcpToolName('maps', 'route')).toBe('mcp__maps__route')
    expect(new Set(names).size).toBe(names.length)
    expect(names.every(name => /^\w{1,64}$/.test(name))).toBe(true)
    expect(createMcpToolName('one', 'foo')).not.toBe(createMcpToolName('two', 'foo'))
  })

  it('resolves collisions across namespaces independently of catalog order', () => {
    const sources = [
      { serverId: 'maps-id', namespace: 'maps', toolNames: ['routing__search'] },
      { serverId: 'routing-id', namespace: 'maps__routing', toolNames: ['search'] },
    ]
    const names = new McpToolNames().assign(sources)
    const reversed = new McpToolNames().assign([...sources].reverse())
    const assigned = sources.map(source => names.get(source.serverId)!.get(source.toolNames[0]!)!)
    expect(new Set(assigned).size).toBe(2)
    expect(assigned.every(name => /^\w{1,64}$/.test(name))).toBe(true)
    for (const source of sources)
      expect(reversed.get(source.serverId)).toEqual(names.get(source.serverId))
  })

  it('preserves ownership when catalogs add, withdraw and restore conflicting tools', () => {
    const allocator = new McpToolNames()
    const original = { serverId: 'maps-id', namespace: 'maps', toolNames: ['foo-bar'] }
    const name = allocator.assign([original]).get(original.serverId)!.get('foo-bar')!
    expect(name).toBe('mcp__maps__foo_bar')
    const expanded = { ...original, toolNames: ['foo_bar', 'foo-bar'] }
    const names = allocator.assign([expanded]).get(original.serverId)!
    expect(names.get('foo-bar')).toBe(name)
    expect(names.get('foo_bar')).not.toBe(name)
    const withdrawn = allocator.assign([{ ...original, toolNames: ['foo_bar'] }]).get(original.serverId)!
    expect(withdrawn.get('foo_bar')).toBe(names.get('foo_bar'))
    allocator.assign([])
    const replacement = allocator.assign([{ ...original, serverId: 'replacement-id' }]).get('replacement-id')!
    expect(replacement.get('foo-bar')).not.toBe(name)
    expect(allocator.assign([expanded]).get(original.serverId)).toEqual(names)
  })

  it('requires approval for every tool regardless of server hints', () => {
    const classification = (annotations: Tool['annotations']) => [...create(annotations).classifications.values()][0]
    expect(classification({ readOnlyHint: true, openWorldHint: false })).toMatchObject({ access: 'network', requireApproval: true })
    expect(classification({ destructiveHint: false })).toMatchObject({ access: 'network', requireApproval: true })
    expect(classification(undefined)).toMatchObject({ access: 'network', requireApproval: true })
  })

  it('preserves structured business fields, image blocks and resource URIs', async () => {
    const result = await normalizeMcpResult({
      content: [{ type: 'text', text: 'token_count=18' }, { type: 'resource_link', name: 'Report', uri: 'mcp://reports/1' }, { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }],
      structuredContent: { token_count: 18, secret_recipe: 'business data' },
      isError: true,
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('mcp://reports/1') })
    expect(JSON.stringify(result.content)).toContain('secret_recipe')
    expect(result.content[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' })
  })

  it('saves complete long text and audio instead of silently dropping data', async () => {
    const saved: Array<{ bytes: Uint8Array, mime: string }> = []
    const text = '长文本'.repeat(30000)
    const result = await normalizeMcpResult({ content: [{ type: 'text', text }, { type: 'audio', mimeType: 'audio/wav', data: 'aGVsbG8=' }] }, async (bytes, mime) => {
      saved.push({ bytes, mime })
      return { artifactId: String(saved.length), path: `/fixture/${saved.length}` }
    })
    expect(result.artifactIds).toEqual(['1', '2'])
    expect(saved[0]?.mime).toBe('audio/wav')
    expect(new TextDecoder().decode(saved[1]?.bytes)).toContain(text)
    expect(JSON.stringify(result.content).length).toBeLessThan(64000)
  })

  it('retains the complete result when the optional artifact writer fails', async () => {
    const remote = { content: [{ type: 'text' as const, text: 'x'.repeat(100000) }], structuredContent: { tail: 'complete' }, _meta: { private: 'host only' } }
    const result = await normalizeMcpResult(remote, async () => {
      throw new Error('disk full')
    })
    expect(result.isError).toBe(false)
    expect(result.artifactIds).toEqual([])
    expect(result.structuredContent).toEqual({ content: remote.content, structuredContent: remote.structuredContent })
    expect(JSON.stringify(result.content)).not.toContain('host only')
    expect(JSON.stringify(result.content).length).toBeLessThan(64000)
  })

  it('does not hide cancellation as a tool failure', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled')
    const result = createMcpTools({ serverId: 'one', serverName: 'One', generation: 1, tools: [tool], callTool: async () => {
      controller.abort(reason)
      throw reason
    } })
    await expect(execute(result.tools[0]!, controller.signal)).rejects.toBe(reason)
  })

  it('does not materialize files for read-only conversations', async () => {
    const remote = { content: [{ type: 'audio' as const, data: 'aGVsbG8=', mimeType: 'audio/wav' }] }
    const result = await normalizeMcpResult(remote)
    expect(result).toMatchObject({ artifactIds: [], isError: false, structuredContent: remote })
  })
})

function execute(tool: ToolDefinition, signal: AbortSignal) {
  return tool.execute('call-1', {}, signal, undefined, {} as never)
}

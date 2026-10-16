import type { ChatAgentPanelNode, ChatAgentReasoningNode, ChatAgentToolNode, ChatAgentTurnNode } from '../chatAgentTurn'
import { describe, expect, it } from 'vitest'
import { presentChatActivityLayout } from '../chatActivityLayout'
import { summarizeChatActivityCounts } from '../chatActivitySummary'
import { createChatAgentActivityProjector } from '../chatAgentActivities'
import { canExpandChatTool, describeChatTool } from '../chatToolDisplay'

describe('activity grouping', () => {
  it.each(['user', 'harness', 'mixed'] as const)('groups consecutive %s panel operations while preserving every source record', (actor) => {
    const nodes = [panel('open', actor === 'harness' ? 'harness' : 'user'), panel('close', actor === 'user' ? 'user' : 'harness', 'close')]
    const original = structuredClone(nodes)
    expect(createChatAgentActivityProjector().project(nodes)).toMatchObject([
      { kind: 'panel-group', actor, nodes },
    ])
    expect(nodes).toEqual(original)
  })

  it('separates panel groups at tools, reasoning, narration and compaction without changing tool counts', () => {
    const boundaries: ChatAgentTurnNode[] = [tool('one'), thought('reasoning'), { id: 'narration', kind: 'text', messageId: 'message', text: 'Next step' }, { id: 'compaction', kind: 'compaction', status: 'completed', tokensBefore: 100, estimatedTokensAfter: 50 }]
    const nodes = boundaries.flatMap((boundary, index) => [panel(`${index}:open`), panel(`${index}:close`, 'harness', 'close'), boundary])
    nodes.push(panel('last'))
    const rows = createChatAgentActivityProjector().project(nodes)
    expect(rows.map(row => row.kind)).toEqual(['panel-group', 'activity-group', 'panel-group', 'activity-group', 'panel-group', 'text', 'panel-group', 'compaction', 'panel-group'])
    expect(rows.flatMap<ChatAgentTurnNode>(row => 'nodes' in row ? row.nodes : [row])).toEqual(nodes)
    expect(rows.filter(row => row.kind === 'activity-group').map(row => row.toolCount)).toEqual([1, 0])
  })

  it('derives local execution, approval and interruption independently from issue counts', () => {
    const projector = createChatAgentActivityProjector()
    expect(projector.project([thought('a', 'running'), tool('bad', 'failed'), tool('pending', 'awaiting_approval')])[0]).toMatchObject({ status: 'running', issueCount: 1, approvalCount: 1, reasoningCount: 1 })
    expect(projector.project([thought('a'), tool('pending', 'awaiting_approval')])[0]).toMatchObject({ status: 'awaiting_approval', approvalCount: 1 })
    expect(projector.project([tool('preparing', 'preparing'), tool('pending', 'awaiting_approval')])[0]).toMatchObject({ status: 'preparing', approvalCount: 1 })
    expect(projector.project([thought('a', 'interrupted'), tool('done')])[0]).toMatchObject({ status: 'interrupted' })
    expect(projector.project([tool('cancelled', 'cancelled'), tool('done')])[0]).toMatchObject({ status: 'interrupted' })
    expect(projector.project([thought('a'), tool('done')])[0]).toMatchObject({ status: 'completed' })
  })

  it('keeps alternating thinking and calls together and separates public narration and compaction', () => {
    const nodes: ChatAgentTurnNode[] = [thought('a'), tool('one'), thought('b'), tool('two'), { id: 'update', kind: 'text', messageId: 'message', phase: 'commentary', text: 'Next step' }, tool('three'), { id: 'compaction', kind: 'compaction', status: 'completed', tokensBefore: 100, estimatedTokensAfter: 50 }, thought('c')]
    const rows = createChatAgentActivityProjector().project(nodes)
    expect(rows.map(row => row.kind)).toEqual(['activity-group', 'text', 'activity-group', 'compaction', 'activity-group'])
    expect(rows[0]).toMatchObject({ nodes: nodes.slice(0, 4), toolCount: 2, icon: 'activity', counts: [{ category: 'read', count: 2 }] })
    expect(rows[2]).toMatchObject({ icon: 'file' })
  })

  it('counts distinct file paths per operation and bounds the summary without losing calls', () => {
    const nodes: ChatAgentToolNode[] = [tool('read-1'), tool('read-2'), ...(['created', 'edited'] as const).map(operation => ({ ...tool(operation), toolName: operation === 'created' ? 'write' : 'edit', presentation: { card: 'diff' as const, operation, path: 'output.txt', diff: null, firstChangedLine: null, description: null, output: null, truncated: false } })), { ...tool('search'), toolName: 'grep', presentation: { card: 'search', query: 'output', path: '.', glob: null, description: null, output: null, truncated: false } }]
    const group = createChatAgentActivityProjector().project(nodes)[0]!
    if (group.kind !== 'activity-group')
      throw new Error('Expected activity group')
    expect(group.nodes).toEqual(nodes)
    expect(group.toolCount).toBe(5)
    expect(summarizeChatActivityCounts(group, 'zh-CN')).toBe('创建 1 个文件 · 编辑 1 个文件 · 读取 1 个文件 · 另 1 次调用')
    expect(summarizeChatActivityCounts(group, 'zh-CN', Infinity)).toBe('创建 1 个文件 · 编辑 1 个文件 · 读取 1 个文件 · 搜索 1 次')
    const unknown = createChatAgentActivityProjector().project([{ ...tool('create'), toolName: 'write', presentation: { card: 'generic', argumentNames: [], description: null, output: null, truncated: false } }])[0]!
    if (unknown.kind === 'activity-group')
      expect(summarizeChatActivityCounts(unknown, 'zh-CN')).toBe('创建 1 次')
  })

  it('merges adjacent reasoning in order without changing source nodes or crossing tool boundaries', () => {
    const first = { ...thought('first'), text: '**First**\n\nDetails' }
    const second = { ...thought('second'), text: 'Second paragraph' }
    const third = { ...thought('third'), text: 'After tools' }
    const fourth = { ...thought('fourth'), text: 'Last paragraph' }
    const nodes = [first, second, tool('one'), tool('two'), third, fourth]
    const original = structuredClone(nodes)
    const layout = presentChatActivityLayout(nodes)
    expect(layout.entries.filter(entry => entry.kind !== 'tool-details')).toEqual([
      { ...first, text: '**First**\n\nDetails\n\nSecond paragraph' },
      nodes[2],
      nodes[3],
      { ...third, text: 'After tools\n\nLast paragraph' },
    ])
    expect(nodes).toEqual(original)
  })

  it.each([
    ['completed', 'running', 'running'],
    ['interrupted', 'running', 'running'],
    ['interrupted', 'completed', 'interrupted'],
    ['completed', 'interrupted', 'interrupted'],
  ] as const)('combines reasoning states %s and %s as %s, including empty active blocks', (first, last, status) => {
    const layout = presentChatActivityLayout([thought('first', first), { ...thought('last', last), text: '' }])
    expect(layout.entries).toEqual([{ ...thought('first', status) }])
  })

  it('disambiguates filenames with the shortest unique suffix and retains repeated reads', () => {
    const nodes = ['src/a/index.ts', 'src/b/index.ts', 'lib/a/index.ts', 'src/a/index.ts', 'src/main.ts'].map((path, index) => {
      const node = tool(String(index))
      node.presentation.path = path
      return node
    })
    const layout = presentChatActivityLayout(nodes)
    expect([...layout.compact.values()].map(value => value.target)).toEqual(['src/a/index.ts', 'b/index.ts', 'lib/a/index.ts', 'src/a/index.ts', 'main.ts'])
    nodes[0]!.presentation.path = 'C:\\skills\\review\\SKILL.md'
    nodes[1]!.presentation.path = 'D:\\skills\\review\\SKILL.md'
    expect([...presentChatActivityLayout(nodes.slice(0, 2)).compact.values()].map(value => value.target)).toEqual(['C:/skills/review', 'D:/skills/review'])
  })
})

function panel(id: string, actor: ChatAgentPanelNode['actor'] = 'user', action: ChatAgentPanelNode['action'] = 'open'): ChatAgentPanelNode {
  return { id: `panel:${id}`, kind: 'panel', actor, action, status: 'completed' }
}

describe('tool display registration', () => {
  it('keeps external calls generic even when their output uses a built-in card', () => {
    const presentation = { card: 'diff', operation: 'created', path: 'output.txt', diff: null, firstChangedLine: null, description: null, output: null, truncated: false } as const
    const node: ChatAgentToolNode = { ...tool('extension'), toolName: 'extension_file', presentation }
    expect(describeChatTool(node, 'zh-CN')).toMatchObject({ label: '工具调用', icon: 'tool', target: 'extension_file' })
  })

  it('keeps full paths available while emphasizing the filename on both platforms', () => {
    const node = tool('one')
    expect(describeChatTool(node, 'zh-CN')).toMatchObject({ target: 'Row.vue', context: 'src/components/', fullTarget: 'src/components/Row.vue' })
    expect(describeChatTool({ ...node, presentation: { ...node.presentation, card: 'read', path: 'C:\\workspace\\Row.vue', language: null, lineStart: 1 } }, 'en-US')).toMatchObject({ target: 'Row.vue', context: 'C:\\workspace\\' })
  })

  it('does not expose denied output and preserves an unfamiliar tool name', () => {
    const node: ChatAgentToolNode = { ...tool('external', 'denied'), toolName: 'external_tool', presentation: { card: 'generic', argumentNames: [], description: null, output: 'not authorized', truncated: false } }
    expect(canExpandChatTool(node)).toBe(false)
    expect(describeChatTool(node, 'zh-CN')).toMatchObject({ label: '工具调用', target: 'external_tool', status: '未获批准' })
    expect(canExpandChatTool({ ...node, presentation: { card: 'diff', operation: 'edited', path: 'private.txt', diff: '+1 private', firstChangedLine: 1, output: null, truncated: false, description: null } })).toBe(false)
  })
})

function tool(id: string, status: ChatAgentToolNode['status'] = 'completed'): ChatAgentToolNode & { presentation: Extract<ChatAgentToolNode['presentation'], { card: 'read' }> } {
  return { id: `tool:${id}`, toolCallId: id, toolName: 'read', kind: 'tool', status, description: null, isError: false, presentation: { card: 'read', path: 'src/components/Row.vue', lineStart: 1, language: null, description: null, output: 'content', truncated: false } }
}

function thought(id: string, status: ChatAgentReasoningNode['status'] = 'completed'): ChatAgentReasoningNode {
  return { id, contentIndex: 0, kind: 'reasoning', messageId: 'reply', status, text: '**Checking the display**' }
}

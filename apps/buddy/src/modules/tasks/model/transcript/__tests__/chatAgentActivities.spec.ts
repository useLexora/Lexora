import type { ChatAgentReasoningNode, ChatAgentToolNode, ChatAgentTurnNode } from '../chatAgentTurn'
import { describe, expect, it } from 'vitest'
import { presentChatActivityLayout } from '../chatActivityLayout'
import { summarizeChatActivity, summarizeChatActivityCounts } from '../chatActivitySummary'
import { createChatAgentActivityProjector } from '../chatAgentActivities'
import { canExpandChatTool, describeChatTool } from '../chatToolDisplay'
import { projectExtensionActionTool } from '../chatTranscriptActivities'

describe('activity grouping', () => {
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
    expect(rows[0]).toMatchObject({ nodes: nodes.slice(0, 4), toolCount: 2, counts: [{ category: 'read', count: 2 }] })
  })

  it('retains group identity, untouched groups and call order across streamed updates and late completion', () => {
    const first = tool('one', 'running')
    const last = tool('two')
    const narration: ChatAgentTurnNode = { id: 'update', kind: 'text', messageId: 'message', phase: 'commentary', text: 'Next step' }
    const projector = createChatAgentActivityProjector()
    const initial = projector.project([first, narration, last])
    const updated = projector.project([{ ...first, status: 'failed', isError: true }, narration, last])
    expect(updated[0]?.id).toBe(initial[0]?.id)
    expect(updated[0]).toMatchObject({ issueCount: 1, nodes: [{ toolCallId: 'one' }] })
    expect(updated[1]).toBe(initial[1])
    expect(updated[2]).toBe(initial[2])
    expect(initial[0]).toMatchObject({ issueCount: 0, toolCount: 1 })
    const replayed = createChatAgentActivityProjector().project([{ ...first, status: 'failed', isError: true }, narration, last])
    expect(replayed).toEqual(updated)
  })

  it('keeps its key when an initially empty leading reasoning block becomes visible', () => {
    const projector = createChatAgentActivityProjector()
    const call = tool('one')
    const first = projector.project([call])
    const next = projector.project([thought('leading'), call])
    expect(next[0]?.id).toBe(first[0]?.id)
  })

  it('keeps accumulated counts while tools wait for approval and reasoning continues', () => {
    const nodes = [tool('one', 'awaiting_approval'), thought('a', 'running'), tool('two', 'running'), tool('three')]
    const row = createChatAgentActivityProjector().project(nodes)[0]!
    expect(row).toMatchObject({ toolCount: 3, counts: [{ category: 'read', count: 3 }] })
    if (row.kind !== 'activity-group')
      throw new Error('Expected activity group')
    expect(summarizeChatActivity(row, 'zh-CN')).toMatchObject({ label: '思考 · 读取 1 个文件' })
  })

  it('settles a completed group immediately using its own tool semantics', () => {
    const group = createChatAgentActivityProjector().project([tool('one')])[0]!
    if (group.kind !== 'activity-group')
      throw new Error('Expected activity group')
    expect(summarizeChatActivity(group, 'zh-CN')).toMatchObject({ label: '读取 1 个文件', icon: 'file' })
  })

  it('retains a shared tool icon and uses an activity list for mixed operations', () => {
    const projector = createChatAgentActivityProjector()
    const reads = projector.project([tool('one'), tool('two')])[0]!
    const mixed = projector.project([tool('one'), { ...tool('two'), toolName: 'write', presentation: { card: 'diff', operation: 'created', path: 'output.txt', diff: null, firstChangedLine: null, description: null, output: null, truncated: false } }])[0]!
    if (reads.kind !== 'activity-group' || mixed.kind !== 'activity-group')
      throw new Error('Expected activity groups')
    expect(summarizeChatActivity(reads, 'zh-CN')).toMatchObject({ label: '读取 1 个文件', icon: 'file' })
    expect(summarizeChatActivity(mixed, 'zh-CN')).toMatchObject({ icon: 'activity' })
  })

  it.each(['before', 'after'] as const)('uses the aggregate icon with reasoning %s a command, independent of execution status', (position) => {
    const command: ChatAgentToolNode = { ...tool('command'), toolName: 'bash', presentation: { card: 'terminal', command: 'pwd', cwd: '.', description: null, output: null, exitCode: null, signal: null, truncated: false } }
    for (const status of ['running', 'completed', 'interrupted'] as const) {
      const reasoning = thought('thought', status)
      const nodes = position === 'before' ? [reasoning, command] : [command, reasoning]
      const group = createChatAgentActivityProjector().project(nodes)[0]!
      if (group.kind !== 'activity-group')
        throw new Error('Expected activity group')
      expect(summarizeChatActivity(group, 'zh-CN')).toEqual({ icon: 'activity', label: '思考 · 运行 1 条命令' })
    }
  })

  it('does not change the summary when only a large tool output is appended', () => {
    const call = tool('one', 'running')
    const projector = createChatAgentActivityProjector()
    const first = projector.project([call])[0]!
    const next = projector.project([{ ...call, presentation: { ...call.presentation, output: 'x'.repeat(64 * 1024) } }])[0]!
    if (first.kind !== 'activity-group' || next.kind !== 'activity-group')
      throw new Error('Expected activity groups')
    expect(summarizeChatActivity(next, 'zh-CN')).toEqual(summarizeChatActivity(first, 'zh-CN'))
  })

  it('counts distinct file paths per operation and bounds the summary without losing calls', () => {
    const nodes: ChatAgentToolNode[] = [tool('read-1'), tool('read-2'), ...(['created', 'edited'] as const).map(operation => ({ ...tool(operation), presentation: { card: 'diff' as const, operation, path: 'output.txt', diff: null, firstChangedLine: null, description: null, output: null, truncated: false } })), { ...tool('search'), toolName: 'grep', presentation: { card: 'search', query: 'output', path: '.', glob: null, description: null, output: null, truncated: false } }]
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

  it('compacts completed reads with the same semantics and puts their details after the headers', () => {
    const nodes = [tool('one'), tool('two'), thought('boundary'), tool('three'), tool('four', 'failed'), tool('five'), tool('six'), tool('seven', 'awaiting_approval')]
    const layout = presentChatActivityLayout(nodes)
    expect([...layout.compact].map(([id, value]) => [id, value.position])).toEqual([['tool:one', 'start'], ['tool:two', 'continuation'], ['tool:five', 'start'], ['tool:six', 'continuation']])
    expect(layout.entries.slice(0, 5).map(entry => entry.id)).toEqual(['tool:one', 'tool:two', 'details:tool:one', 'details:tool:two', 'boundary'])
    expect(layout.entries.filter(entry => entry.kind !== 'tool-details')).toEqual(nodes)
    const skill = tool('skill')
    skill.presentation.path = 'skills/review/SKILL.md'
    expect(presentChatActivityLayout([skill, tool('file')]).compact.size).toBe(0)
  })

  it('merges adjacent reasoning in order without changing source nodes or crossing tool boundaries', () => {
    const first = { ...thought('first'), text: '**First**\n\nDetails' }
    const second = { ...thought('second'), text: 'Second paragraph' }
    const third = { ...thought('third'), text: 'After tools' }
    const fourth = { ...thought('fourth'), text: 'Last paragraph' }
    const nodes = [first, second, tool('one'), tool('two'), third, fourth]
    const original = structuredClone(nodes)
    const layout = presentChatActivityLayout(nodes)
    expect(layout.entries).toEqual([
      { ...first, text: '**First**\n\nDetails\n\nSecond paragraph' },
      nodes[2],
      nodes[3],
      { id: 'details:tool:one', kind: 'tool-details', node: nodes[2] },
      { id: 'details:tool:two', kind: 'tool-details', node: nodes[3] },
      { ...third, text: 'After tools\n\nLast paragraph' },
    ])
    expect(nodes).toEqual(original)
    expect(presentChatActivityLayout([first]).entries[0]).toBe(first)
  })

  it.each([
    ['completed', 'completed', 'completed'],
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
    expect([...layout.compact.values()].map(value => value.hasNext)).toEqual([true, true, true, true, false])
    expect(layout.entries.filter(entry => entry.kind === 'tool-details')).toHaveLength(5)
    nodes[0]!.presentation.path = 'C:\\skills\\review\\SKILL.md'
    nodes[1]!.presentation.path = 'D:\\skills\\review\\SKILL.md'
    expect([...presentChatActivityLayout(nodes.slice(0, 2)).compact.values()].map(value => value.target)).toEqual(['C:/skills/review', 'D:/skills/review'])
  })
})

describe('tool display registration', () => {
  it.each(['/workspace/skills/ui-review/SKILL.md', 'skills/ui-review/SKILL.md', 'C:\\skills\\ui-review\\SKILL.md'])('identifies a skill entry from %s without reading its contents', (path) => {
    const node = tool('skill')
    node.presentation.path = path
    expect(describeChatTool(node, 'zh-CN')).toMatchObject({ label: '读取技能', icon: 'skill', target: 'ui-review', context: '', fullTarget: path })
    expect(describeChatTool(node, 'en-US').label).toBe('Read skill')
    expect(createChatAgentActivityProjector().project([node])[0]).toMatchObject({ counts: [{ category: 'read', count: 1 }] })
  })

  it('keeps skill reference documents as ordinary file reads', () => {
    const node = tool('reference')
    node.presentation.path = '/workspace/skills/ui-review/references/layout.md'
    expect(describeChatTool(node, 'zh-CN')).toMatchObject({ label: '读取文件', icon: 'file', target: 'layout.md' })
  })

  it.each([
    ['ls', '列出目录', 'List directory', 'directory'],
    ['find', '查找文件', 'Find files', 'search'],
    ['write', '创建文件', 'Create file', 'create'],
    ['edit', '编辑文件', 'Edit file', 'edit'],
    ['lexora_tool_search', '查找可用工具', 'Find available tools', 'search'],
    ['lexora_output_present', '展示产物', 'Present output', 'artifact'],
    ['lexora_image_chroma_key', '图片抠像', 'Remove image background', 'image-edit'],
  ])('preserves %s semantics before its structured result exists', (name, chinese, english, icon) => {
    const node: ChatAgentToolNode = { ...tool(name, 'awaiting_approval'), toolName: name, presentation: { card: 'generic', argumentNames: [], description: null, output: null, truncated: false } }
    expect(describeChatTool(node, 'zh-CN')).toMatchObject({ label: chinese, icon })
    expect(describeChatTool(node, 'en-US').label).toBe(english)
  })

  it('keeps external calls generic even when their output uses a built-in card', () => {
    const presentation = { card: 'diff', operation: 'created', path: 'output.txt', diff: null, firstChangedLine: null, description: null, output: null, truncated: false } as const
    const node: ChatAgentToolNode = { ...tool('extension'), toolName: 'extension_file', presentation }
    expect(describeChatTool(node, 'zh-CN')).toMatchObject({ label: '工具调用', icon: 'tool', target: 'extension_file' })
    expect(describeChatTool({ ...node, presentation: { ...presentation, operation: 'edited' } }, 'zh-CN')).toMatchObject({ label: '工具调用', icon: 'tool', target: 'extension_file' })
    const reads = [tool('one'), tool('two')].map(node => ({ ...node, toolName: 'external_read' }))
    expect(presentChatActivityLayout(reads).compact.size).toBe(0)
  })

  it('omits argument names from output presentation while keeping a meaningful description', () => {
    const node: ChatAgentToolNode = { ...tool('output'), toolName: 'lexora_output_present', presentation: { card: 'generic', argumentNames: ['paths'], description: null, output: null, truncated: false } }
    expect(describeChatTool(node, 'zh-CN')).toMatchObject({ label: '展示产物', icon: 'artifact', target: '' })
    expect(describeChatTool({ ...node, description: 'preview.html' }, 'zh-CN')).toMatchObject({ target: 'preview.html' })
  })

  it('keeps full paths available while emphasizing the filename on both platforms', () => {
    const node = tool('one')
    expect(describeChatTool(node, 'zh-CN')).toMatchObject({ target: 'Row.vue', context: 'src/components/', fullTarget: 'src/components/Row.vue' })
    expect(describeChatTool({ ...node, presentation: { ...node.presentation, card: 'read', path: 'C:\\workspace\\Row.vue', language: null, lineStart: 1 } }, 'en-US')).toMatchObject({ target: 'Row.vue', context: 'C:\\workspace\\' })
  })

  it('uses a registered runtime label when no localized display registration exists', () => {
    const node: ChatAgentToolNode = { ...tool('external'), toolName: 'external_tool', toolLabel: 'Query local data', presentation: { card: 'generic', argumentNames: [], description: null, output: null, truncated: false } }
    expect(describeChatTool(node, 'zh-CN')).toMatchObject({ label: '工具调用', icon: 'tool', target: 'Query local data', context: '' })
    expect(describeChatTool(node, 'en-US')).toMatchObject({ label: 'Tool call', target: 'Query local data' })
  })

  it('uses the same heading for connector calls and independent plugin actions', () => {
    const node: ChatAgentToolNode = { ...tool('mcp'), toolName: 'mcp_server_lookup', presentation: { card: 'connector', connector: 'Local data', tool: 'lookup', argumentNames: [], description: null, output: 'found', truncated: false } }
    expect(describeChatTool(node, 'zh-CN')).toMatchObject({ label: '工具调用', icon: 'tool', target: 'lookup', context: '' })
    const action = projectExtensionActionTool({ kind: 'extension-action', id: 'action', conversationId: 'conversation', branchId: 'branch', sourceMessageId: 'source', extensionId: 'tests.title', extensionName: '标题自动生成', actionId: 'tests.title.generate', title: '重新生成标题', trigger: 'user', status: 'completed', message: '已更新', createdAt: '2026-09-29T00:00:00.000Z', completedAt: '2026-09-29T00:00:01.000Z' })
    expect(describeChatTool(action, 'zh-CN')).toMatchObject({ label: '工具调用', icon: 'tool', target: '重新生成标题', context: '', status: '已完成' })
    const group = createChatAgentActivityProjector().project([action, thought('checking'), node, tool('read')])[0]!
    expect(group).toMatchObject({ toolCount: 3, counts: [{ category: 'other', count: 2 }, { category: 'read', count: 1 }] })
    if (group.kind === 'activity-group')
      expect(summarizeChatActivity(group, 'zh-CN').label).toBe('思考 · 读取 1 个文件 · 工具调用 2 次')
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
  return { id, contentIndex: 0, kind: 'reasoning', status, text: '**Checking the display**' }
}

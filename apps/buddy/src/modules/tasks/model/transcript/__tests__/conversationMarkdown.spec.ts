import type { LocalConversationTimelinePage } from '@buddy-shared/conversation/conversationApi'
import { describe, expect, it } from 'vitest'
import { ConversationExportSizeError, formatConversationMarkdown, markdownFence } from '../conversationMarkdown'
import { at, conversation, event, message, page, run, terminal } from './conversationMarkdownFixtures'

function format(timeline: LocalConversationTimelinePage, extra: Partial<Parameters<typeof formatConversationMarkdown>[0]> = {}) {
  return formatConversationMarkdown({ conversation: conversation(), title: '排查启动失败', exportedAt: at, language: 'en-US', timeline, ...extra })
}

describe('conversation Markdown', () => {
  it('copies original Markdown, metadata, localized roles and an empty conversation', () => {
    const body = '**原文**\n\n```ts\nconst a = 1\n```'
    const output = format(page({ items: [message('user', 'user', body), message('answer', 'assistant', '回答', { runId: null })] }), { language: 'zh-CN', title: '# 标题\n[链接]' })
    expect(output).toContain('# \\# 标题 \\[链接\\]')
    expect(output).toContain('- 会话 ID: conversation')
    expect(output).toContain('- 分支 ID: branch')
    expect(output).toContain('## 用户')
    expect(output).toContain(body)
    expect(output.indexOf(body)).toBeLessThan(output.indexOf('回答'))
    expect(format(page())).toContain('_No messages._')
  })

  it('restores commentary and terminal deltas once, in event order even at identical timestamps', () => {
    const events = [
      event(1, 'message.completed', { messageId: 'commentary', phase: 'commentary', content: { text: '先检查命令' } }),
      event(2, 'tool.started', { toolCallId: 'call', toolName: 'powershell', presentation: terminal('first') }),
      event(3, 'tool.updated', { toolCallId: 'call', toolName: 'powershell', presentationDelta: { card: 'terminal', outputStart: 5, outputDelta: '\nsecond', truncated: true } }),
      event(4, 'tool.completed', { toolCallId: 'call', toolName: 'powershell', isError: true, presentation: { ...terminal('first\nsecond'), exitCode: 1, truncated: true } }),
      event(5, 'message.completed', { messageId: 'answer', phase: 'final_answer', content: { text: '最终答案' } }),
    ]
    const output = format(page({ runs: [run()], runEvents: events.reverse(), items: [message('user', 'user', '问题'), message('commentary', 'assistant', '先检查命令'), message('answer', 'assistant', '最终答案')] }))
    expect(output.match(/先检查命令/g)).toHaveLength(1)
    expect(output.match(/最终答案/g)).toHaveLength(1)
    expect(output.match(/first\nsecond/g)).toHaveLength(1)
    expect(output).toContain('Exit code: 1')
    expect(output).toContain('Status: failed (error)')
    expect(output).toContain('Tool output truncated by the source.')
    expect(output.indexOf('问题')).toBeLessThan(output.indexOf('先检查命令'))
    expect(output.indexOf('先检查命令')).toBeLessThan(output.indexOf('### Tool:'))
    expect(output.indexOf('### Tool:')).toBeLessThan(output.indexOf('最终答案'))
  })

  it('restores a running final response not yet persisted without exporting reasoning or internal tool messages', () => {
    const output = format(page({ runs: [run({ status: 'running', completedAt: null })], items: [message('user', 'user', 'question'), message('internal', 'tool', { text: 'PRIVATE_TOOL_PAYLOAD' })], runEvents: [
      event(1, 'message.block.completed', { messageId: 'reasoning', contentIndex: 0, kind: 'reasoning', content: 'PRIVATE_REASONING' }),
      event(2, 'message.started', { messageId: 'stream' }),
      event(3, 'message.delta', { messageId: 'stream', phase: 'final_answer', delta: 'partial answer' }),
    ] }))
    expect(output).toContain('partial answer')
    expect(output).toContain('Status: running')
    expect(output).not.toContain('PRIVATE_REASONING')
    expect(output).not.toContain('PRIVATE_TOOL_PAYLOAD')
  })

  it.each(['cancelled', 'failed'] as const)('marks %s runs and interrupted/truncated persisted replies', (status) => {
    const output = format(page({ runs: [run({ status, errorCode: 'TEST_ERROR' })], items: [message('user', 'user', 'question'), message('answer', 'assistant', { state: 'interrupted', text: 'partial', truncated: true })], runEvents: [event(1, 'run.failed', { errorMessage: 'reported failure' })] }))
    expect(output).toContain(`Status: ${status}`)
    expect(output).toContain('TEST\\_ERROR')
    expect(output).toContain('Message interrupted; content truncated.')
    if (status === 'failed')
      expect(output).toContain('reported failure')
  })

  it('copies saved references and attachment metadata without preview URLs or following references', () => {
    const output = format(page({ items: [message('user', 'user', {
      resourceSnapshots: [],
      userContent: { version: 1, body: [{ type: 'paragraph', content: [{ type: 'text', text: '请继续' }] }], panelResourceIds: [], sessionReferences: [{ id: 'other', title: '另一会话' }], quotes: [{ id: 'q', text: 'saved quote', source: { conversationId: 'other', branchId: 'old', messageId: 'quoted', role: 'assistant', runId: null } }], resourceQuotes: [{ id: 'file-q', text: 'saved file quote', source: { kind: 'file', title: 'notes', file: { spaceId: 'space', directoryId: 'directory', revision: 1, path: 'notes.txt' }, format: 'source' } }] },
    }, { attachments: [{ attachmentId: 'image', name: '# image\nname.png', kind: 'image', mimeType: 'image/png', sizeBytes: 123, previewUrl: 'PRIVATE_PREVIEW_URL' }] })] }))
    expect(output).toContain('Referenced conversation: 另一会话 (ID: other)')
    expect(output).toContain('saved quote')
    expect(output).toContain('saved file quote')
    expect(output).toContain('notes.txt')
    expect(output).toContain('Attachment: \\# image name.png')
    expect(output).not.toContain('PRIVATE_PREVIEW_URL')
  })

  it('recovers interrupted event snapshots and omits internal compaction messages', () => {
    const output = format(page({ runs: [run({ status: 'cancelled' }), run({ id: 'compact-run', purpose: 'conversation.compaction' })], items: [message('user', 'user', 'question'), message('compact-answer', 'assistant', 'PRIVATE_COMPACTION_SUMMARY', { runId: 'compact-run' })], runEvents: [
      event(1, 'message.interrupted', { messageId: 'interrupted', role: 'assistant', content: { state: 'interrupted', text: 'PUBLIC_PARTIAL_REPLY', truncated: true } }),
      event(1, 'message.completed', { messageId: 'compact-answer', phase: 'final_answer', content: { text: 'PRIVATE_COMPACTION_SUMMARY' } }, 'compact-run'),
    ] }))
    expect(output).toContain('PUBLIC_PARTIAL_REPLY')
    expect(output).toContain('Message interrupted; content truncated.')
    expect(output).not.toContain('PRIVATE_COMPACTION_SUMMARY')
  })

  it('lists local references without embedding their contents', () => {
    const output = format(page({ items: [message('user', 'user', { resourceSnapshots: [{ resourceId: 'file', localReference: { kind: 'file', name: 'local.txt', path: 'D:\\project\\local.txt', mimeType: 'text/plain', sizeBytes: 500 } }], userContent: { version: 1, body: [{ type: 'paragraph', content: [{ type: 'resource_ref', resourceId: 'file' }] }], panelResourceIds: [] } })] }))
    expect(output).toContain('@local.txt')
    expect(output).toContain('Attachment: local.txt (text/plain, 500 bytes)')
    expect(output).toContain('Path: D:')
  })

  it('uses a longer fence for logs containing Markdown fences and checks UTF-8 bytes', () => {
    expect(markdownFence('before\n````js\ncode\n````')).toBe('`````text\nbefore\n````js\ncode\n````\n`````')
    expect(() => format(page({ items: [message('user', 'user', '中'.repeat(1_000))] }), { maxBytes: 2_500 })).toThrow(ConversationExportSizeError)
  })

  it('copies generic tools, denied calls, artifact metadata and compact/plugin status without raw event payloads', () => {
    const output = format(page({ items: [message('user', 'user', 'question'), { kind: 'compaction', id: 'compact', conversationId: 'conversation', branchId: 'branch', createdAt: at, completedAt: at, errorCode: null, estimatedTokensAfter: 10, tokensBefore: 100, status: 'completed' }, { kind: 'extension-action', id: 'ext', conversationId: 'conversation', branchId: 'branch', sourceMessageId: 'user', extensionId: 'plugin', extensionName: '插件', actionId: 'action', title: '检查', trigger: 'user', status: 'failed', message: 'plugin failed', createdAt: at, completedAt: at }], runs: [run()], runEvents: [
      event(1, 'tool.started', { toolCallId: 'call', toolName: 'fetch', presentation: { card: 'generic', argumentNames: ['url'], description: null, output: 'public output', truncated: false }, privateField: 'PRIVATE_EVENT_VALUE' }),
      event(2, 'tool.denied', { toolCallId: 'call', toolName: 'fetch', denialCode: 'APPROVAL_DENIED' }),
    ], outputs: [{ createdAt: at, runId: 'run', sourceToolCallId: 'call', artifacts: [{ artifactId: 'artifact', conversationId: 'conversation', runId: 'run', sourceToolCallId: 'call', sourceArtifactId: null, createdAt: at, updatedAt: at, kind: 'file', mimeType: 'text/plain', name: 'result.md', path: 'out/result.md', sizeBytes: 10, previewUrl: 'PRIVATE_ARTIFACT_URL' }] }] }))
    expect(output).toContain('public output')
    expect(output).toContain('Status: denied')
    expect(output).toContain('APPROVAL\\_DENIED')
    expect(output).toContain('Context compaction')
    expect(output).toContain('plugin failed')
    expect(output).toContain('out/result.md')
    expect(output).not.toContain('PRIVATE_EVENT_VALUE')
    expect(output).not.toContain('PRIVATE_ARTIFACT_URL')
  })
})

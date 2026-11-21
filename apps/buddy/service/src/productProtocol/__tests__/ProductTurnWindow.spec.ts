import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PRODUCT_LIMITS, productByteLength } from '../../../../shared/productProtocol/limits'
import { productTurnWindowSchema } from '../../../../shared/productProtocol/turns'
import { RunEventProjector } from '../../events/RunEventProjector'
import { seedSqliteRun } from '../../storage/__tests__/sqliteRunFixture'
import { createArtifactRepository } from '../../storage/artifactRepository'
import { openBuddyMigrationCandidate } from '../../storage/database'
import { withTransaction } from '../../storage/transaction'
import { ProductContentReferences } from '../ProductContentReferences'
import { ProductQueries } from '../ProductQueries'
import { ProductReadViews } from '../ProductReadViews'
import { ProductTurnWindow } from '../ProductTurnWindow'

const scope = { conversationId: 'task-1', branchId: 'branch-task-1' }
const run = { ...scope, runId: 'public' }
let db: DatabaseSync
let directory: string
function fixture() {
  directory = mkdtempSync(join(tmpdir(), 'lexora-turn-window-'))
  db = openBuddyMigrationCandidate({ databasePath: join(directory, 'buddy.sqlite3') })
  seedSqliteRun(db, run.runId)
  return new ProductTurnWindow(db, 'instance', new ProductReadViews(db, 'reader', new ProductContentReferences(db, 'reader')))
}
afterEach(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})
function at(n: number) {
  return new Date(Date.parse('2026-09-29T00:00:00Z') + n).toISOString()
}
function event(seq: number, type: string, data: unknown, runId = run.runId) {
  db.prepare('INSERT INTO run_events (run_id,sequence,event_type,payload_json,created_at) VALUES (?,?,?,?,?)').run(runId, seq, type, JSON.stringify(data), at(seq))
}
function message(id: string, role: string, data: unknown, seq: number, owner: string | null = run.runId, branchId = scope.branchId) {
  db.prepare('INSERT INTO messages (id,conversation_id,branch_id,run_id,role,content_json,created_at) VALUES (?,?,?,?,?,?,?)').run(id, scope.conversationId, branchId, owner, role, JSON.stringify(data), at(seq))
}

describe('轻量任务轮次', () => {
  it('按公开说明拆分工具组并分页，不包含私有执行或空说明', () => {
    const reader = fixture()
    const secret = 'NEVER_WIRE_COMMAND_OR_LOG'
    for (let n = 1; n <= 4; n++) {
      const call = { toolCallId: `task-${n}`, toolName: 'bash' }
      const isError = n === 2
      event(n * 4, 'tool.started', { ...call, presentation: { command: secret } })
      if (isError)
        event(n * 4 + 1, 'tool.failed', call)
      event(n * 4 + 2, 'tool.completed', { ...call, isError, presentation: { output: secret } })
      message(`log-${n}`, 'tool', { ...call, isError }, n * 4 + 3)
      if (isError)
        message('explanation', 'assistant', { text: '重试打包' }, n * 4 + 3)
      if (n === 3)
        message('tool-use-empty', 'assistant', { text: '' }, n * 4 + 3)
    }
    seedSqliteRun(db, 'private')
    db.prepare('UPDATE runs SET execution_kind=\'npc_child\',root_run_id=\'public\' WHERE id=\'private\'').run()
    event(1, 'tool.started', { toolName: 'private_tool', toolCallId: 'private-call' }, 'private')
    message('private-body', 'assistant', { text: secret }, 100, 'private')
    const page = productTurnWindowSchema.parse(reader.page(scope))
    expect(page.items.filter(m => m.runId === run.runId).map(x => x.id)).toEqual(['explanation'])
    expect(page.items.find(x => x.id === 'explanation')).toMatchObject({ turnRootId: 'public', turnInputId: 'input-public' })
    expect(page.groups).toMatchObject([
      { afterMessageId: 'input-public', toolCount: 2, failedCount: 1, counts: [{ category: 'command', count: 2 }] },
      { afterMessageId: 'explanation', toolCount: 2, failedCount: 0 },
    ])
    expect(JSON.stringify(page)).not.toContain(secret)
    expect(JSON.stringify(page)).not.toContain('private_tool')
    const input = { ...run, groupId: page.groups[0]!.id, limit: 1 }
    const first = reader.steps(input)
    const second = reader.steps({ ...input, cursor: first.nextCursor })
    expect(second).toMatchObject({ nextCursor: null, items: [{ toolName: 'bash', status: 'failed', messageId: 'log-2' }] })
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id)
    const finalCall = { toolName: 'bash', toolCallId: 'pending' }
    event(1000, 'tool.preparing', finalCall)
    expect(reader.groupForCall({ ...run, toolCallId: 'pending' })).toMatchObject({ toolCount: 3, runningCount: 1 })
    event(1001, 'tool.denied', finalCall)
    expect(reader.groupForCall({ ...run, toolCallId: 'pending' })).toMatchObject({ toolCount: 3, failedCount: 1, runningCount: 0 })
    event(1002, 'tool.started', finalCall)
    db.prepare('UPDATE runs SET status=\'cancelled\' WHERE id=\'public\'').run()
    expect(reader.interruptedGroups(run)).toMatchObject([{ toolCount: 4, interruptedCount: 1, runningCount: 0 }])
  })

  it('只包含祖先分叉点之前的调用及回复，步骤游标不能跨组/分支使用', () => {
    const reader = fixture()
    for (const n of [1, 2, 5]) {
      const call = { toolCallId: `call-${n}`, toolName: 'read', isError: false }
      event(n, 'tool.completed', call)
      message(`result-${n}`, 'tool', call, n)
    }
    message('fork', 'assistant', { text: '可见' }, 3)
    message('later', 'assistant', { text: '祖先后文' }, 6)
    db.prepare('INSERT INTO conversation_branches(id,conversation_id,parent_branch_id,forked_from_message_id,created_at) VALUES(?,?,?,?,?)').run('child', scope.conversationId, scope.branchId, 'fork', at(7))
    message('child-input', 'user', { text: '分支' }, 8, null, 'child')
    const view = reader.page({ ...scope, branchId: 'child' })
    expect(view.items.map(x => x.id)).toEqual(['input-public', 'fork', 'child-input'])
    expect(view.groups).toMatchObject([{ toolCount: 2, afterMessageId: 'input-public' }])
    const child = { ...run, branchId: 'child', groupId: view.groups[0]!.id, limit: 1 }
    const page = reader.steps(child)
    expect(reader.steps({ ...child, cursor: page.nextCursor }).items[0]).toMatchObject({ messageId: 'result-2' })
    expect(() => reader.steps({ ...child, branchId: scope.branchId, cursor: page.nextCursor })).toThrow('CURSOR_EXPIRED')
    expect(reader.groupForCall({ ...run, branchId: 'child', toolCallId: 'call-5' })).toBeNull()
    expect(reader.resolveStep({ ...child, stepId: page.items[0]!.id })).toBeNull()
    db.prepare('UPDATE conversations SET deleted_at = ? WHERE id = ?').run(at(9), scope.conversationId)
    expect(() => reader.page(scope)).toThrow('OBJECT_DELETED')
  })

  it('能证明本 run 叉点序号时只还原该前缀的思考和被拒步骤，不读取祖先后来事实', () => {
    const reader = fixture()
    const block = { kind: 'reasoning', messageId: 'cut', contentIndex: 0 }
    event(1, 'message.block.started', block)
    event(2, 'message.block.completed', { ...block, content: 'private reasoning' })
    event(3, 'tool.denied', { toolCallId: 'before', toolName: 'read' })
    new RunEventProjector(db).project([{ runId: 'public', sequence: 4, createdAt: at(4), type: 'message.completed', payload: { messageId: 'cut', role: 'assistant', content: { text: '公开叉点' }, stopReason: 'completed' } }])
    db.prepare('INSERT INTO conversation_branches(id,conversation_id,parent_branch_id,forked_from_message_id,created_at) VALUES(?,?,?,?,?)').run('fork', scope.conversationId, scope.branchId, 'cut', at(4))
    event(5, 'tool.started', { toolCallId: 'after', toolName: 'hidden_after' })
    db.prepare('UPDATE run_events SET created_at=? WHERE sequence=5 AND run_id=?').run(at(3), 'public')
    db.exec('UPDATE runs SET status=\'failed\',error_code=\'INTERNAL_ERROR\' WHERE id=\'public\'')
    const fork = reader.page({ ...scope, branchId: 'fork' })
    expect(fork.groups).toMatchObject([{ reasoningCount: 1, toolCount: 1, failedCount: 1, activeToolName: null }])
    expect(fork.runs).toEqual([])
    expect(JSON.stringify(fork)).not.toMatch(/hidden_after|private reasoning|INTERNAL_ERROR/)
    const step = reader.steps({ ...run, branchId: 'fork', groupId: fork.groups[0]!.id }).items[0]!
    expect(step).toMatchObject({ toolName: 'read', status: 'failed', messageId: null })
    db.prepare('UPDATE conversation_publications SET source_sequence = 3 WHERE message_id = ?').run('cut')
    expect(reader.page({ ...scope, branchId: 'fork' }).groups).toEqual([])
  })

  it('第二页的无正文轮带回产物归属及终态，大量无输出重试不占首屏', () => {
    const reader = fixture()
    const now = at(0)
    message('stop-input', 'user', { text: '停止' }, 1, null)
    const putRun = db.prepare(`INSERT INTO runs(id,conversation_id,branch_id,triggering_message_id,provider,model,purpose,status,started_at) VALUES(?,?,?,?,'fixture','fixture','chat',?,?)`)
    withTransaction(db, () => {
      db.prepare('UPDATE runs SET status=\'completed\' WHERE id=\'public\'').run()
      for (let i = 0; i < 1030; i++) putRun.run(`retry-${i}`, scope.conversationId, scope.branchId, 'input-public', 'failed', at(i + 2))
      putRun.run('stopped', scope.conversationId, scope.branchId, 'stop-input', 'cancelled', now)
      createArtifactRepository(db).save({ id: 'apk', conversationId: scope.conversationId, currentPath: '/fixture/test.apk', directoryRoot: '/fixture', directoryGrantId: scope.conversationId, relativePath: 'test.apk', kind: 'file', name: 'test.apk', mimeType: 'application/octet-stream', sizeBytes: 120, sourceArtifactId: null, createdAt: now, updatedAt: now })
      new RunEventProjector(db).project([{ runId: 'public', sequence: 1, createdAt: now, type: 'output.produced', payload: { artifactIds: ['apk'], sourceToolCallId: 'publish', sourceToolName: 'lexora_output_present' } }])
      const short = reader.page(scope)
      expect(short.runs.map(r => r.id)).toHaveLength(3)
      for (let i = 0; i < 28; i++) message(`filler-${i}`, 'user', { text: 'X'.repeat(4096) }, 2000 + i, null)
    })
    const queries = new ProductQueries(db, 'reader', 'instance')
    const page = (cursor: string | null) => productTurnWindowSchema.parse(queries.read('conversations.getTurnWindow', { ...scope, cursor }))
    const first = page(null)
    expect(first.runs).toEqual([])
    expect(first.nextCursor).not.toBeNull()
    const second = page(first.nextCursor)
    expect(second.items.filter(m => m.role === 'assistant')).toEqual([])
    expect(second.runs.map(r => [r.id, r.status])).toEqual([['public', 'completed'], ['stopped', 'cancelled'], ['retry-1029', 'failed']])
    expect(productByteLength(JSON.stringify(second))).toBeLessThan(PRODUCT_LIMITS.pageBytes)
    const output = queries.read('runs.listOutputs', { runId: second.runs[0]!.id, branchId: scope.branchId, cursor: null, limit: 5 })
    expect(output).toMatchObject({ items: [{ resourceId: 'artifact:apk', name: 'test.apk' }] })
  })

  it('思考块只计一次，不传过程正文；仅思考也能结束或中断', () => {
    const reader = fixture()
    const block = { messageId: 'answer', contentIndex: 0, kind: 'reasoning' }
    const input = { ...run, messageId: block.messageId, contentIndex: 0 }
    event(1, 'message.block.started', block)
    expect(reader.groupForReasoning(input)).toMatchObject({ toolCount: 0, reasoningCount: 1, runningReasoningCount: 1 })
    event(2, 'message.block.delta', { ...block, delta: 'private thought' })
    event(3, 'message.block.completed', { ...block, content: 'private thought' })
    event(4, 'tool.started', { toolName: 'bash', toolCallId: 'compile' })
    const group = reader.groupForReasoning(input)!
    expect(group).toMatchObject({ toolCount: 1, reasoningCount: 1, runningReasoningCount: 0 })
    expect(reader.groupForCall({ ...run, toolCallId: 'compile' })?.id).toBe(group.id)
    expect(JSON.stringify(reader.page(scope))).not.toContain('private thought')
    event(5, 'message.block.started', { ...block, contentIndex: 1 })
    event(6, 'message.interrupted', { messageId: block.messageId })
    expect(reader.reasoningGroupsForMessage(input)).toMatchObject([{ id: group.id, reasoningCount: 2, interruptedReasoningCount: 1, runningReasoningCount: 0 }])
  })

  it('公开伙伴的说明归到根输入但不公开其工具/内部触发上下文', () => {
    const reader = fixture()
    seedSqliteRun(db, 'actor')
    db.exec('UPDATE runs SET execution_kind=\'actor_child\', root_run_id=\'public\', triggering_message_id=\'private-mailbox-source\' WHERE id=\'actor\'')
    message('actor-summary', 'assistant', { text: '检查通过' }, 5, 'actor')
    event(6, 'tool.started', { toolName: 'private_tool', toolCallId: 'actor-call' }, 'actor')
    event(7, 'tool.started', { toolName: 'read', toolCallId: 'public-call' })
    const page = reader.page(scope)
    expect(page.items.find(m => m.id === 'actor-summary')).toMatchObject({ runId: 'actor', turnRootId: 'public', turnInputId: 'input-public' })
    expect(reader.binding({ ...scope, runId: 'actor', messageId: 'actor-summary' })).toEqual({ turnRootId: 'public', turnInputId: 'input-public' })
    expect(page.groups).toMatchObject([{ runId: 'public', toolCount: 1, afterMessageId: 'actor-summary' }])
    expect(JSON.stringify(page)).not.toMatch(/private_tool|private-mailbox-source/)
    expect(reader.groupForCall({ ...scope, runId: 'actor', toolCallId: 'actor-call' })).toBeNull()
  })

  it('步骤在保存详情前不可点，同一序号时间的重试不会把后来结果挂给旧步骤', () => {
    const reader = fixture()
    const call = { toolName: 'bash', toolCallId: 'reused' }
    event(1, 'tool.started', call)
    event(2, 'tool.completed', { ...call, isError: true })
    const groupId = reader.groupForCall({ ...run, toolCallId: call.toolCallId })!.id
    const input = { ...run, groupId }
    expect(reader.steps(input).items[0]).toMatchObject({ status: 'failed', messageId: null })
    message('first-log', 'tool', { ...call, isError: true }, 3)
    event(3, 'message.tool_result', { messageId: 'first-log', content: { ...call, isError: true } })
    event(4, 'tool.started', call)
    event(5, 'tool.completed', { ...call, isError: false })
    message('second-log', 'tool', { ...call, isError: false }, 6)
    event(6, 'message.tool_result', { messageId: 'second-log', content: { ...call, isError: false } })
    db.prepare('UPDATE run_events SET created_at=? WHERE run_id=?').run(at(1), run.runId)
    db.prepare('UPDATE messages SET created_at=? WHERE run_id=? AND role=\'tool\'').run(at(1), run.runId)
    const items = reader.steps(input).items
    expect(items).toMatchObject([{ status: 'failed', messageId: 'first-log' }, { status: 'completed', messageId: 'second-log' }])
    expect(new Set(items.map(s => s.id)).size).toBe(2)
  })

  it('活跃轮在历史候选范围之外仍能定位到问题、中途说明和当前活动', () => {
    const reader = fixture()
    message('working', 'assistant', { text: '还在执行' }, 1)
    event(2, 'tool.started', { toolName: 'read', toolCallId: 'check' })
    db.exec('BEGIN')
    for (let i = 0; i < 1040; i++) message(`later-${i}`, 'user', { text: '其他公开输入' }, i + 3, null)
    db.exec('COMMIT')
    const page = reader.page(scope)
    expect(page.items.slice(0, 2).map(m => m.id)).toEqual(['input-public', 'working'])
    expect(page.groups).toMatchObject([{ afterMessageId: 'working', runningCount: 1, activeToolName: 'read' }])
    expect(page.nextCursor).not.toBeNull()
  })

  it('预算可跨越50条短消息，超预算停在上一轮的输入/答复之间而非截断一轮', () => {
    const reader = fixture()
    db.prepare('UPDATE runs SET status=\'completed\' WHERE id=\'public\'').run()
    for (let i = 1; i <= 80; i++) {
      const id = `run-${i}`
      message(`question-${i}`, 'user', { text: '任务' }, i * 3, null)
      db.prepare(`INSERT INTO runs(id,conversation_id,branch_id,triggering_message_id,provider,model,purpose,status,started_at) VALUES(?,?,?,?,'fixture','fixture','chat','completed',?)`).run(id, scope.conversationId, scope.branchId, `question-${i}`, at(i * 3))
      message(`answer-${i}`, 'assistant', { text: i < 40 ? 'X'.repeat(4096) : '完成' }, i * 3 + 1, id)
    }
    const first = reader.page(scope)
    expect(first.items.length).toBeGreaterThan(50)
    expect(first.nextCursor).not.toBeNull()
    expect(first.items[0]?.role).toBe('user')
    expect(first.items.at(-1)?.id).toBe('answer-80')
    const second = reader.page({ ...scope, cursor: first.nextCursor })
    expect(second.items.at(-1)?.role).toBe('assistant')
    const ids = new Set(first.items.map(x => x.id))
    expect(second.items.some(x => ids.has(x.id))).toBe(false)
  })
})

import type { AssistantMessage, TextContent } from '@earendil-works/pi-ai'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { productReadLiveTextResultSchema, productReadSavedTextInputSchema } from '../../../../shared/productProtocol/messageText'
import { productConversationTurnsChangeSchema, productConversationTurnsItemSchema } from '../../../../shared/productProtocol/topics'
import { createPiEventProjectionState, projectPiEvent } from '../../agent/events/projectPiEvent'
import { RunEventProjector } from '../../events/RunEventProjector'
import { seedSqliteRun } from '../../storage/__tests__/sqliteRunFixture'
import { openBuddyMigrationCandidate } from '../../storage/database'
import { ProductQueries } from '../ProductQueries'
import { projectProductTurnChange } from '../projectProductTurnChange'

const scope = { conversationId: 'task-1', branchId: 'branch-task-1' }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'lexora-mixed-'))
  const db = openBuddyMigrationCandidate({ databasePath: join(dir, 'fixture.sqlite3') })
  onTestFinished(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  db.exec('UPDATE storage_profile SET authority=\'sqlite\', migration_state=\'ready\'')
  seedSqliteRun(db, 'root')
  const queries = new ProductQueries(db, 'reader', 'test')
  const projector = new RunEventProjector(db)
  let n = 0
  function append(runId: string, content: AssistantMessage['content']) {
    const last = (n * 1000) + Date.parse('2026-09-30T00:00:00Z')
    const msg: AssistantMessage = { api: 'openai-codex-responses', provider: 'openai-codex', model: 'fixture', role: 'assistant', timestamp: last, stopReason: 'stop', content, usage: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } }
    const state = createPiEventProjectionState()
    const start = projectPiEvent({ type: 'message_start', message: msg }, state)
    const thinking = content[0]?.type === 'thinking' ? projectPiEvent({ type: 'message_update', message: msg, assistantMessageEvent: { type: 'thinking_end', content: content[0].thinking, contentIndex: 0, partial: msg } }, state).events : []
    const end = projectPiEvent({ type: 'message_end', message: msg }, state)
    const events = [...start.events, ...thinking, ...end.events].map(e => ({ ...e, runId, sequence: ++n, createdAt: new Date(last + n).toISOString() }))
    projector.append(events)
    return { messageId: end.sourceMessageId!, completion: events.at(-1)! }
  }
  return { db, queries, append }
}
function text(value: string, phase: 'final_answer' | 'commentary'): TextContent {
  return { type: 'text', text: value, textSignature: JSON.stringify({ id: `block-${phase}`, v: 1, phase }) }
}

it('用同一公开消息身份发布和恢复混合说明：独立说明不重复，推理不入正文，长说明按保存版本读取', () => {
  const { append, queries, db } = fixture()
  const standalone = append('root', [text('独立说明', 'commentary')])
  const long = `${'😀'.repeat(20_000)}末尾`
  const full = `password=[redacted]\n\n${long}`
  const mixed = append('root', [{ type: 'thinking', thinking: 'PRIVATE_REASONING' }, text('password=SYNTHETIC_ONLY', 'commentary'), text(long, 'commentary'), text('最终答复', 'final_answer')])
  const changes = projectProductTurnChange(queries, db, { ...scope, executionKind: 'root' }, mixed.completion).map(e => productConversationTurnsChangeSchema.parse(e))
  const published = changes.find(c => c.kind === 'upsert' && c.item.entity === 'message')
  if (published?.kind !== 'upsert' || published.item.entity !== 'message')
    throw new Error('Missing final message upsert')
  const row = published.item.value
  expect(row).toMatchObject({ id: mixed.messageId, body: { text: '最终答复' }, commentary: { range: { revision: `c:${mixed.completion.sequence}`, end: full.length, total: full.length } } })
  const { text: suffix, range } = row.commentary!
  expect(suffix).toBe(full.slice(range.start))
  expect(suffix.length).toBeLessThanOrEqual(2048)
  expect(range.start).toBeGreaterThan(0)
  expect(suffix.isWellFormed()).toBe(true)
  const recovered = queries.openSnapshot(`conversationTurns:${scope.conversationId}:${scope.branchId}`)
  try {
    const items = recovered.read(null).items.map(e => productConversationTurnsItemSchema.parse(e))
    const assistants = items.flatMap(i => i.entity === 'message' && i.value.role === 'assistant' ? [i.value] : [])
    expect(assistants.map(m => m.id)).toEqual([standalone.messageId, mixed.messageId])
    expect(assistants[0]?.commentary).toBeUndefined()
    expect(assistants[1]).toEqual(row)
    expect(JSON.stringify(items)).not.toMatch(/PRIVATE_REASONING|SYNTHETIC_ONLY/)
  }
  finally { recovered.close() }
  let received = suffix
  let offset = range.start
  const read = (at: number, direction: 'before' | 'after', revision = range.revision) => productReadLiveTextResultSchema.parse(queries.read('conversations.readSavedText', productReadSavedTextInputSchema.parse({ ...scope, messageId: mixed.messageId, revision, offset: at, direction })))
  while (offset > 0) {
    const page = read(offset, 'before')
    expect(page.range.end).toBe(offset)
    expect(page.range.start).toBeLessThan(offset)
    expect(page.text.isWellFormed()).toBe(true)
    received = page.text + received
    offset = page.range.start
  }
  expect(received).toBe(full)
  expect(read(0, 'after').text).toBe(full.slice(0, read(0, 'after').range.end))
  expect(() => read(range.start, 'before', `c:${mixed.completion.sequence + 1}`)).toThrow('SOURCE_CHANGED')
  expect(() => read(full.indexOf('😀') + 1, 'after')).toThrow('INVALID_PARAMS')
})

it('最终正文为空时仍恢复同一消息的公开说明，没有说明的空轮次则不占行', () => {
  const { append, queries } = fixture()
  const mixed = append('root', [text('先完成了检查', 'commentary'), text('', 'final_answer')])
  const empty = append('root', [text('', 'final_answer')])
  const page = queries.turns.page(scope)
  expect(page.items.find(m => m.id === mixed.messageId)).toMatchObject({ body: { text: '' }, commentary: { text: '先完成了检查' } })
  expect(page.items.find(m => m.id === empty.messageId)).toBeUndefined()
})

it('子执行不可借已知的消息 ID 和版本读取混合文本块', () => {
  const { db, queries, append } = fixture()
  for (const kind of ['actor_child', 'npc_child']) {
    seedSqliteRun(db, kind)
    db.prepare('UPDATE runs SET execution_kind=?, root_run_id=\'root\' WHERE id=?').run(kind, kind)
    const { messageId, completion } = append(kind, [text('PRIVATE_CHILD_DETAIL', 'commentary'), text('结果', 'final_answer')])
    const page = queries.turns.page(scope)
    if (kind === 'actor_child')
      expect(page.items.find(m => m.id === messageId)).toMatchObject({ body: { text: '结果' } })
    else expect(page.items.find(m => m.id === messageId)).toBeUndefined()
    expect(JSON.stringify(page)).not.toContain('PRIVATE_CHILD_DETAIL')
    expect(() => queries.turns.readSavedText({ ...scope, messageId, revision: `c:${completion.sequence}`, direction: 'after', offset: 0 })).toThrow(/SOURCE_CHANGED|RESOURCE_UNAVAILABLE/)
  }
})

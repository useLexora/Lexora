import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { productReadActivityStepDetailResultSchema, STEP_DETAIL_TEXT_LIMIT } from '../../../../shared/productProtocol/activityStepDetail'
import { seedSqliteRun } from '../../storage/__tests__/sqliteRunFixture'
import { openBuddyMigrationCandidate } from '../../storage/database'
import { readActivityStepDetail } from '../ProductActivityStepDetail'
import { ProductContentReferences } from '../ProductContentReferences'
import { ProductReadViews } from '../ProductReadViews'
import { ProductTurnWindow } from '../ProductTurnWindow'

it('reads only the selected public occurrence; watches contiguous published previews and never raw arguments or another retry', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lexora-step-detail-'))
  const db = openBuddyMigrationCandidate({ databasePath: join(directory, 'test.sqlite3') })
  try {
    const scope = { conversationId: 'task-1', branchId: 'branch-task-1', runId: 'public' }
    seedSqliteRun(db, 'public')
    seedSqliteRun(db, 'private')
    db.prepare('UPDATE runs SET execution_kind = \'npc_child\',root_run_id = \'public\' WHERE id = \'private\'').run()
    const turns = new ProductTurnWindow(db, 'test', new ProductReadViews(db, 'reader', new ProductContentReferences(db, 'reader')))
    const insert = db.prepare('INSERT INTO run_events (run_id,sequence,event_type,payload_json,created_at) VALUES (?,?,?,?,?)')
    const event = (seq: number, type: string, fields: object, key = 'reuse', run = 'public') => insert.run(run, seq, type, JSON.stringify({ toolCallId: key, toolName: 'bash', args: 'RAW PARAMS', rawLog: 'RAW LOG', ...fields }), new Date(Date.UTC(2026, 10, 1) + seq).toISOString())
    const presentation = (command: string, output: string) => ({ card: 'terminal', command, output, description: null, cwd: null, exitCode: null, signal: null, truncated: false })
    event(1, 'tool.preparing', { presentation: presentation('make apk --token secretValue', '') })
    event(1, 'tool.started', { presentation: presentation('PRIVATE COMMAND', 'PRIVATE LOG') }, 'reuse', 'private')
    event(2, 'tool.started', { presentation: presentation('OTHER COMMAND', 'OTHER LOG') }, 'other')
    const page = turns.page(scope)
    const group = { ...scope, groupId: page.groups[0]!.id }
    const list = turns.steps(group)
    expect(JSON.stringify([page, list])).not.toMatch(/make apk|secretValue|PRIVATE|OTHER COMMAND|RAW LOG/)
    const target = { ...group, stepId: list.items[0]!.id }
    const read = (params = target, revision?: string) => productReadActivityStepDetailResultSchema.parse(readActivityStepDetail(db, turns, { ...params, knownRevision: revision }))
    const initial = read()
    expect(initial).toMatchObject({ status: 'running', available: true, text: 'make apk --token=[redacted]', messageId: null })
    expect(read(target, initial.revision).text).toBeNull()
    event(3, 'tool.updated', { presentationDelta: { card: 'terminal', outputStart: 0, outputDelta: 'Build token=', truncated: false } })
    event(4, 'tool.updated', { presentationDelta: { card: 'terminal', outputStart: 12, outputDelta: 'secretValue', truncated: false } })
    const progress = read(target, initial.revision)
    expect(progress.text).toContain('Build token=[redacted]')
    expect(progress.text).not.toMatch(/secretValue|OTHER|RAW|PRIVATE/)
    event(5, 'tool.failed', { errorCode: 'PRIVATE CODE', reason: 'PRIVATE REASON' })
    const failed = read()
    expect(failed.status).toBe('failed')
    event(6, 'tool.preparing', { presentation: presentation('SECOND COMMAND', '') })
    event(7, 'tool.completed', { isError: false, presentation: presentation('SECOND COMMAND', 'ok'.repeat(20_000)) })
    expect(read()).toEqual(failed)
    const retried = { ...group, stepId: turns.steps(group).items.at(-1)!.id }
    const completed = read(retried)
    expect(completed).toMatchObject({ status: 'completed', truncated: true })
    expect(completed.text).toContain('SECOND COMMAND')
    expect(completed.text!.length).toBeLessThanOrEqual(STEP_DETAIL_TEXT_LIMIT)
    expect(() => read({ ...target, runId: 'private' })).toThrow('RESOURCE_UNAVAILABLE')
    expect(() => read({ ...target, groupId: 'wrong' })).toThrow('RESOURCE_UNAVAILABLE')
    event(8, 'tool.started', { args: { command: 'NEVER FALL BACK' } }, 'old')
    const old = { ...group, stepId: turns.steps(group).items.at(-1)!.id }
    expect(read(old)).toMatchObject({ available: false, text: null, status: 'running' })

    event(9, 'tool.started', { presentation: presentation('tail-build', '') }, 'long')
    let offset = 0
    for (let n = 0; n < 180; n++) {
      const delta = n === 155 ? '\ntoken=' : n === 156 ? 'secret-from-split\nprogress 156' : `\nprogress ${n}`
      event(n + 10, 'tool.updated', { presentationDelta: { card: 'terminal', outputStart: offset, outputDelta: delta, truncated: false } }, 'long')
      offset += delta.length
    }
    const long = { ...group, stepId: turns.steps(group).items.at(-1)!.id }
    const preview = read(long)
    expect(preview).toMatchObject({ status: 'running', truncated: true })
    expect(preview.text).toContain('tail-build')
    expect(preview.text).toContain('progress 179')
    expect(preview.text).not.toMatch(/secret-from-split|progress 100/)
    event(190, 'tool.updated', { presentationDelta: { card: 'terminal', outputStart: offset, outputDelta: '\nlatest', truncated: false } }, 'long')
    expect(read(long, preview.revision).text).toContain('latest')
  }
  finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

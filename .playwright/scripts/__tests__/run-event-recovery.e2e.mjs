import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from '../fixtures/electron.mjs'

test('startup recovers history once and only rebuilds changed runs after restart', async ({ buddy }, testInfo) => {
  test.setTimeout(120_000)
  const instance = await buddy.createInstance('event-recovery')
  await instance.launch()
  await instance.stop()
  const runCount = 24
  const messagesPerRun = 20
  const now = '2026-10-08T00:00:00.000Z'
  const eventDirectory = path.join(instance.home, 'buddy/conversations/recovery-conversation/events')
  await fs.mkdir(eventDirectory, { recursive: true, mode: 0o700 })
  const databasePath = path.join(instance.home, 'buddy/buddy.sqlite3')
  const database = new DatabaseSync(databasePath)
  try {
    database.exec('PRAGMA foreign_keys = ON')
    database.prepare('INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)')
      .run('recovery-conversation', now, now)
    database.prepare('INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)')
      .run('recovery-branch', 'recovery-conversation', now)
    const insertRun = database.prepare(`INSERT INTO runs
      (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at)
      VALUES (?, 'recovery-conversation', 'recovery-branch', 'recovery-input', 'fixture', 'fixture', 'chat', 'running', ?)`)
    for (let index = 0; index < runCount; index++) {
      const runId = `recovery-${index}`
      insertRun.run(runId, now)
      const events = [
        { type: 'run.started', payload: {} },
        ...Array.from({ length: messagesPerRun }, (_, message) => ({
          type: 'message.completed',
          payload: { messageId: `${runId}-answer-${message}`, role: 'assistant', content: { text: 'Recovery fixture' }, stopReason: 'completed' },
        })),
        { type: 'run.completed', payload: {} },
      ].map((event, position) => ({ ...event, runId, sequence: position + 1, createdAt: now }))
      await fs.writeFile(path.join(eventDirectory, `${runId}.jsonl`), `${events.map(event => JSON.stringify(event)).join('\n')}\n`, { mode: 0o600 })
    }
  }
  finally {
    database.close()
  }

  const measurements = []
  const launch = async () => {
    const { page, diagnostics } = await instance.launch()
    expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
    expect((await page.evaluate(() => window.lexoraDesktop.app.startup.getState())).status).toBe('ready')
    await instance.stop()
    const records = (await fs.readFile(path.join(instance.home, '.runtime/state/logs/application.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    const ready = records.findLast(record => record.event === 'app.ready')
    const current = records.filter(record => record.launchId === ready.launchId)
    const measurement = {
      startupMs: ready.durationMs,
      recoveryMs: current.find(record => record.event === 'run.recovery.finished').durationMs,
      rebuilt: current.find(record => record.event === 'run.recovery.projected').count,
      skipped: current.find(record => record.event === 'run.recovery.skipped').count,
    }
    measurements.push(measurement)
    return measurement
  }
  const messages = () => {
    const database = new DatabaseSync(databasePath, { readOnly: true })
    try {
      return database.prepare('SELECT rowid, id, content_json FROM messages ORDER BY id').all()
    }
    finally {
      database.close()
    }
  }

  expect(await launch()).toMatchObject({ rebuilt: runCount, skipped: 0 })
  const recovered = messages()
  expect(recovered).toHaveLength(runCount * messagesPerRun)
  expect(await launch()).toMatchObject({ rebuilt: 0, skipped: runCount })
  expect(messages()).toEqual(recovered)

  await fs.appendFile(path.join(eventDirectory, 'recovery-0.jsonl'), `${JSON.stringify({
    runId: 'recovery-0',
    sequence: messagesPerRun + 3,
    createdAt: now,
    type: 'message.completed',
    payload: { messageId: 'recovery-late-answer', role: 'assistant', content: { text: 'Durable after checkpoint' }, stopReason: 'completed' },
  })}\n`)
  expect(await launch()).toMatchObject({ rebuilt: 1, skipped: runCount - 1 })
  expect(messages()).toEqual([...recovered, expect.objectContaining({ id: 'recovery-late-answer', content_json: '{"text":"Durable after checkpoint"}' })])
  await testInfo.attach('startup-recovery', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' })
})

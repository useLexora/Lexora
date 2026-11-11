import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))

export async function prepareTaskArchiveProfile(home, output, authority = 'legacy_jsonl', { legacyTasks = 1, legacyFiles = 1 } = {}) {
  assert.equal(authority, 'legacy_jsonl')
  assert(Number.isInteger(legacyTasks) && legacyTasks >= 1 && legacyTasks <= 100)
  assert(Number.isInteger(legacyFiles) && legacyFiles >= 1 && legacyFiles <= 64)
  const legacyTaskIds = Array.from({ length: legacyTasks }, (_, index) => index ? `archive-legacy-${index}` : 'archive-legacy')
  const requireBuddy = createRequire(path.join(root, 'apps/buddy/package.json'))
  const { build } = await import(pathToFileURL(requireBuddy.resolve('vite')).href)
  await build({ configFile: false, logLevel: 'error', build: {
    ssr: path.join(root, '.playwright/scripts/__tests__/task-archive-profile.ts'),
    outDir: output,
    target: 'node26',
    rolldownOptions: { external: isBuiltin, output: { entryFileNames: 'prepare.mjs', format: 'es' } },
  } })
  const { openBuddyDatabase } = await import(pathToFileURL(path.join(output, 'prepare.mjs')).href)
  const databasePath = path.join(home, 'buddy/buddy.sqlite3')
  const database = openBuddyDatabase({ databasePath })
  try {
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 42)
    assert.deepEqual(database.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name IN (\'storage_profile\', \'managed_files\') ORDER BY name').all().map(row => row.name), [])
    const now = new Date().toISOString()
    for (const [id, name, revoked] of [['archive-space-design', '设计空间', null], ['archive-space-old', '历史研究空间', now]])
      database.prepare('INSERT INTO spaces (id, name, memory_scope, revoked_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, 'space_only', revoked, now, now)
    const tasks = [
      ['archive-active', '可归档的历史任务', null, null],
      ['archive-existing', '已经归档的历史任务', now, null],
      ['archive-notes', '整理桌面工作台交互细节与后续改进记录，保留完整上下文供下次继续', now, null, 'archive-space-design'],
      ['archive-review', '检查本地数据的保留范围与恢复流程', now, null, 'archive-space-old'],
      ['archive-space-active', '设计空间中的活动任务', null, null, 'archive-space-design'],
      ['archive-failed', '清理失败的历史任务', now, now],
      ...legacyTaskIds.map((id, index) => [id, `模拟旧版已移除任务 ${index + 1}`, null, now]),
    ]
    for (const [id, title, archived, deleted, spaceId] of tasks) {
      database.prepare('INSERT INTO conversations (id, title, buddy_id, active_branch_id, created_at, updated_at, archived_at, deleted_at, space_id) VALUES (?, ?, (SELECT default_buddy_id FROM buddy_catalog WHERE id = 1), ?, ?, ?, ?, ?, ?)').run(id, title, `branch-${id}`, now, now, archived, deleted, spaceId ?? null)
      database.prepare('INSERT INTO conversation_members (conversation_id, actor_id, joined_at) SELECT ?, default_buddy_id, ? FROM buddy_catalog WHERE id = 1').run(id, now)
      database.prepare('INSERT INTO task_attention (conversation_id) VALUES (?)').run(id)
      database.prepare('INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)').run(`branch-${id}`, id, now)
      database.prepare('INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(`message-${id}`, id, `branch-${id}`, 'user', JSON.stringify({ text: `保留的历史内容 ${id}` }), now)
    }
    database.prepare('INSERT INTO conversation_deletion_jobs (conversation_id, status, error_code, created_at, updated_at) VALUES (\'archive-failed\', \'failed\', \'FILE_ACCESS_DENIED\', ?, ?)').run(now, now)
  }
  finally { database.close() }
  const owned = path.join(home, 'buddy/conversations/archive-legacy/workspace')
  const activeOwned = path.join(home, 'buddy/conversations/archive-active/workspace')
  for (const id of legacyTaskIds) {
    const directory = path.join(home, 'buddy/conversations', id, 'workspace')
    await fs.mkdir(directory, { recursive: true })
    await Promise.all(Array.from({ length: legacyFiles }, (_, index) => fs.writeFile(path.join(directory, index ? `owned-${index}.txt` : 'owned.txt'), 'Task-owned fixture')))
  }
  const external = path.join(home, 'external')
  for (const directory of [owned, activeOwned]) {
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, 'owned.txt'), 'Task-owned fixture')
  }
  await fs.mkdir(external, { recursive: true })
  await fs.writeFile(path.join(external, 'keep.txt'), 'External fixture must survive')
  return { databasePath, owned, activeOwned, external, legacyTaskIds }
}

export async function readTaskArchiveStorage(app, databasePath) {
  return app.evaluate(({ app }, databasePath) => {
    if (app.getName() !== 'Lexora Buddy Test')
      throw new Error('Archive assertions require an isolated test profile')
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const database = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const tables = database.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name IN (\'storage_profile\', \'managed_files\') ORDER BY name').all().map(row => row.name)
      return {
        version: database.prepare('PRAGMA user_version').get().user_version,
        tables,
      }
    }
    finally { database.close() }
  }, databasePath)
}

export async function taskExists(app, databasePath, id) {
  return app.evaluate(({ app }, { databasePath, id }) => {
    if (app.getName() !== 'Lexora Buddy Test')
      throw new Error('Archive assertions require an isolated test profile')
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const database = new DatabaseSync(databasePath, { readOnly: true })
    try {
      return !!database.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id)
    }
    finally { database.close() }
  }, { databasePath, id })
}

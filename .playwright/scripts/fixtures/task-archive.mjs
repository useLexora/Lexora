import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))

export async function prepareTaskArchiveProfile(home, output, authority, { legacyTasks = 1, legacyFiles = 1 } = {}) {
  assert.ok(['legacy_jsonl', 'sqlite'].includes(authority), 'Archive fixture requires an explicit storage authority')
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
  const { openBuddyDatabase, openBuddySqliteDatabase } = await import(pathToFileURL(path.join(output, 'prepare.mjs')).href)
  const databasePath = path.join(home, 'buddy/buddy.sqlite3')
  const open = authority === 'legacy_jsonl' ? openBuddyDatabase : openBuddySqliteDatabase
  const database = open({ databasePath })
  try {
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, authority === 'legacy_jsonl' ? 42 : 43)
    assert.deepEqual(database.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name IN (\'storage_profile\', \'managed_files\') ORDER BY name').all().map(row => row.name), authority === 'legacy_jsonl' ? [] : ['managed_files', 'storage_profile'])
    if (authority === 'sqlite')
      assert.equal(database.prepare('SELECT authority FROM storage_profile WHERE id = 1').get().authority, 'sqlite')
    const now = new Date().toISOString()
    const tasks = [
      ['archive-active', '可归档的历史任务', null, null],
      ['archive-existing', '已经归档的历史任务', now, null],
      ...legacyTaskIds.map((id, index) => [id, `模拟旧版已移除任务 ${index + 1}`, null, now]),
    ]
    for (const [id, title, archived, deleted] of tasks) {
      database.prepare('INSERT INTO conversations (id, title, buddy_id, active_branch_id, created_at, updated_at, archived_at, deleted_at) VALUES (?, ?, (SELECT default_buddy_id FROM buddy_catalog WHERE id = 1), ?, ?, ?, ?, ?)').run(id, title, `branch-${id}`, now, now, archived, deleted)
      database.prepare('INSERT INTO conversation_members (conversation_id, actor_id, joined_at) SELECT ?, default_buddy_id, ? FROM buddy_catalog WHERE id = 1').run(id, now)
      database.prepare('INSERT INTO task_attention (conversation_id) VALUES (?)').run(id)
      database.prepare('INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)').run(`branch-${id}`, id, now)
      database.prepare('INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(`message-${id}`, id, `branch-${id}`, 'user', JSON.stringify({ text: `保留的历史内容 ${id}` }), now)
    }
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
  await fs.mkdir(activeOwned, { recursive: true })
  await fs.mkdir(external, { recursive: true })
  await fs.writeFile(path.join(activeOwned, 'owned.txt'), 'Task-owned fixture')
  await fs.writeFile(path.join(external, 'keep.txt'), 'External fixture must survive')
  return { databasePath, owned, activeOwned, external, legacyTaskIds }
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

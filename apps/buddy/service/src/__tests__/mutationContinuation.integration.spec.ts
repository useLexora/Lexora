import type { LocalChangeRecoveryItem } from '../../../shared/changes/changeApi'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { expect, it } from 'vitest'
import { resolveBuddyPlatform } from '../../../shared/platform'
import { createMutationRepository } from '../changes/mutationRepository'
import { createConversationRepository } from '../storage/conversationRepository'
import { createRunRepository } from '../storage/runRepository'
import { assertDurableTree, createConcurrencyRuntime, roles, tool } from './mutationConcurrencyFixture'

it.skipIf(!resolveBuddyPlatform(process.platform).hostShellSupervision)('starts a real execution tree and supervised command despite persisted unknown shell and MCP outcomes', async () => {
  const invocationIds = [randomUUID(), randomUUID()]
  let workspace = ''
  let command = ''
  const f = await createConcurrencyRuntime({
    fullAccess: true,
    async prepare(database) {
      const now = new Date().toISOString()
      const conversationId = randomUUID()
      const messageId = randomUUID()
      const runId = randomUUID()
      const conversations = createConversationRepository(database)
      conversations.create({ id: conversationId, branchId: conversationId, createdAt: now, approvalPolicy: 'policy', executionProfile: 'full_access', spaceId: null, title: 'Legacy interrupted fixture' })
      conversations.createMessage({ id: messageId, conversationId, branchId: conversationId, role: 'user', runId: null, createdAt: now, content: { text: 'Legacy fixture; no external request is issued' } })
      createRunRepository(database).create({ id: runId, conversationId, branchId: conversationId, triggeringMessageId: messageId, provider: 'fixture', model: 'fixture', purpose: 'chat', status: 'failed', startedAt: now, completedAt: now, errorCode: 'RUNTIME_RESTARTED', approvalPolicy: 'policy', executionProfile: 'full_access', piSessionFile: null })
      const repository = createMutationRepository(database)
      for (const [index, kind] of ['legacy-shell', 'mcp'].entries()) {
        const invocationId = invocationIds[index]!
        repository.createLease({ invocationId, runId, segmentId: randomUUID(), lifetime: 'external', claims: [{ kind: 'host' }] })
        repository.recordProcess(invocationId, JSON.stringify({ kind, nonce: 'unverifiable-legacy-fixture' }), 'unknown')
        repository.settle(invocationId, 'hazard', 'OWNED_PROCESS_CLEANUP_UNCONFIRMED')
      }
    },
    steps: role => [
      tool(`continue-${role}`, 'write', { path: join(workspace, `${role}.txt`), content: `continued:${role}\n` }),
      ...(role === 'root' ? [tool('continue-shell', process.platform === 'win32' ? 'powershell' : 'bash', { command, timeout: 40 })] : []),
    ],
  })
  try {
    workspace = f.workspace
    const script = join(workspace, 'continue-once.cjs')
    const marker = join(workspace, 'continued.log')
    await writeFile(script, 'require(\'node:fs\').appendFileSync(process.argv[2], \'new-effect\\n\');\n')
    const quote = (value: string) => process.platform === 'win32' ? `'${value.replaceAll('\'', '\'\'')}'` : `'${value.replaceAll('\'', '\'\\\'\'')}'`
    command = `${process.platform === 'win32' ? '& ' : ''}${[process.execPath, script, marker].map(quote).join(' ')}`
    expect(await f.invoke('changes.recovery.list', { conversationId: f.turn.conversationId })).toEqual([])
    f.start()
    await f.complete()
    await assertDurableTree(f)
    for (const role of roles)
      expect(await readFile(join(workspace, `${role}.txt`), 'utf8')).toBe(`continued:${role}\n`)
    expect(await readFile(marker, 'utf8')).toBe('new-effect\n')
    const operations = f.events.filter(event => event.type === 'tool.completed' && String((event.payload as { toolCallId?: string }).toolCallId).startsWith('continue-'))
    expect(operations).toHaveLength(5)
    expect(operations.every(event => (event.payload as { isError?: boolean }).isError === false)).toBe(true)
    const notices = await f.invoke('changes.recovery.list', { conversationId: f.turn.conversationId }) as LocalChangeRecoveryItem[]
    expect(notices.map(item => item.invocationId).sort()).toEqual([...invocationIds].sort())
    expect(notices.every(item => item.status === 'unknown' && item.taskTitle === 'Legacy interrupted fixture')).toBe(true)
    const affectedRunIds = f.runs.listTree(f.turn.runId).map(run => run.id).sort()
    for (const invocationId of invocationIds) {
      const overlaps = f.database.prepare('SELECT related_run_id, reason FROM run_mutation_evidence WHERE invocation_id = ? AND related_run_id IS NOT NULL').all(invocationId)
      expect(overlaps.map(item => item.related_run_id).sort()).toEqual(affectedRunIds)
      expect(overlaps.every(item => item.reason === 'RESOURCE_OVERLAP')).toBe(true)
      expect(f.database.prepare('SELECT status, reason FROM run_mutation_leases WHERE invocation_id = ?').get(invocationId)).toMatchObject({ status: 'hazard', reason: 'OWNED_PROCESS_CLEANUP_UNCONFIRMED' })
      expect(f.database.prepare('SELECT settlement FROM run_mutation_processes WHERE invocation_id = ?').get(invocationId)).toMatchObject({ settlement: 'unknown' })
      expect(f.database.prepare('SELECT COUNT(*) AS count FROM run_mutation_evidence WHERE invocation_id = ? AND (kind = \'waived\' OR outcome = \'applied\')').get(invocationId)?.count).toBe(0)
    }
  }
  finally { await f.dispose() }
}, 60000)

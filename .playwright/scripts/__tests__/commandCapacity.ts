import assert from 'node:assert/strict'
import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { setImmediate as yieldLoop } from 'node:timers/promises'
import { ComposerDraftCommandService } from '../../../apps/buddy/service/src/chat/ComposerDraftCommandService'
import { ComposerDraftService } from '../../../apps/buddy/service/src/chat/ComposerDraftService'
import { CommandAdmissionService, createLocalCommandPrincipal } from '../../../apps/buddy/service/src/commands/CommandAdmissionService'
import { createComposerDraftRepository } from '../../../apps/buddy/service/src/storage/composerDraftRepository'
import { openBuddyMigrationCandidate } from '../../../apps/buddy/service/src/storage/database'
import { createBuddyUserContent } from '../../../apps/buddy/shared/conversation/buddyUserContent'

export async function runCommandCapacity(root: string, bundleSha256: string) {
  const path = join(root, 'capacity.sqlite3')
  const database = openBuddyMigrationCandidate({ databasePath: path })
  database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  const repository = createComposerDraftRepository(database)
  const executionConfig = { approvalPolicy: 'policy', executionProfile: 'read_only' } as const
  repository.open({ draftId: 'capacity', scope: { kind: 'task', draftId: 'capacity', spaceId: null }, initialContent: createBuddyUserContent(), initialExecutionConfig: executionConfig, initialModelSelection: null, now: new Date().toISOString() })
  const drafts = new ComposerDraftService(repository, async () => {})
  const principal = createLocalCommandPrincipal(database)
  const admission = new CommandAdmissionService({ database, principal, sourceInstanceId: 'capacity-instance' })
  const commands = new ComposerDraftCommandService({
    database,
    actorId: principal.actorId,
    admission,
    drafts,
    prepareAttachments: async () => { throw new Error('This workload does not copy files') },
    releaseResources: async () => {},
    onCleanupError: (error) => { throw error },
  })
  const samples: number[] = []
  const dataGeneration = String(database.prepare('SELECT data_generation FROM storage_profile').get()!.data_generation)
  const count = 6000
  const report = {
    platform: process.platform,
    node: process.version,
    bundleSha256,
    commands: count,
    inputCharacters: 16_384,
    continuousTypingEquivalentSeconds: count * 1.5,
    intermittentTypingEquivalentSeconds: count * 0.3,
    limits: { commitP99Ms: 25, bytesPerCommand: 2048, receiptPayloadBytes: 1024 },
    commitP99Ms: 0,
    databaseBytes: 0,
    bytesPerCommand: 0,
    maxReceiptPayloadBytes: 0,
    backupBytes: 0,
    passed: false,
  }
  try {
    const baseline = Number(database.prepare('PRAGMA page_count').get()!.page_count) * Number(database.prepare('PRAGMA page_size').get()!.page_size)
    for (let index = 0; index < count; index++) {
      const started = performance.now()
      const result = await commands.execute('composerDrafts.save', {
        dataGeneration,
        commandId: `save-${index}`,
        expectedServiceInstanceId: 'capacity-instance',
        intent: { draftId: 'capacity', expectedRevision: index, content: createBuddyUserContent(`${index}:`.padEnd(report.inputCharacters, 'x')), executionConfig, modelSelection: null },
      })
      assert.equal(result.receipt.decision, 'accepted')
      samples.push(performance.now() - started)
      if (index % 32 === 0)
        await yieldLoop()
    }
    const sorted = samples.toSorted((a, b) => a - b)
    report.commitP99Ms = sorted[Math.ceil(sorted.length * 0.99) - 1]!
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM command_receipts').get()!.count, count)
    report.maxReceiptPayloadBytes = Number(database.prepare('SELECT MAX(length(CAST(target_json AS BLOB)) + length(CAST(result_json AS BLOB))) AS value FROM command_receipts').get()!.value)
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    report.databaseBytes = (await stat(path)).size
    report.bytesPerCommand = (report.databaseBytes - baseline) / count
    const backup = join(root, 'capacity-backup.sqlite3')
    database.prepare('VACUUM INTO ?').run(backup)
    report.backupBytes = (await stat(backup)).size
    repository.discard({ draftId: 'capacity', expectedRevision: count })
    assert.equal(admission.lookup({ dataGeneration, commandId: 'save-0' }).lookup, 'decided')
    assert.equal(admission.lookup({ dataGeneration, commandId: `save-${count - 1}` }).lookup, 'decided')
    assert(report.commitP99Ms <= report.limits.commitP99Ms)
    assert(report.bytesPerCommand <= report.limits.bytesPerCommand)
    assert(report.maxReceiptPayloadBytes <= report.limits.receiptPayloadBytes)
    report.passed = true
    process.stdout.write(`Command capacity: ${count} decisions, ${report.bytesPerCommand.toFixed(1)} bytes/command, commit P99 ${report.commitP99Ms.toFixed(2)}ms\n`)
  }
  finally {
    await commands.dispose()
    await admission.dispose()
    await drafts.dispose()
    database.close()
    await writeFile(join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
}

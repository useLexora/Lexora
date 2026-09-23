import type { LocalAutomation, LocalAutomationOccurrencePage } from '@buddy-shared/automation/automationApi'
import type { LocalAttachment } from '@buddy-shared/conversation/attachmentApi'
import type { LocalTurnStart } from '@buddy-shared/conversation/chatApi'
import type { LocalContextUsageSnapshot } from '@buddy-shared/conversation/contextApi'
import type { LocalNotificationList } from '@buddy-shared/notifications/notificationApi'
import type { LocalRun, LocalRunEvent } from '@buddy-shared/runs/runApi'
import type { AssistantMessage, Credential, ToolResultMessage, Usage } from '@earendil-works/pi-ai'
import type { AgentSessionEvent, CompactionResult } from '@earendil-works/pi-coding-agent'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { DatabaseSync } from 'node:sqlite'

import type { BuddyComposerResource } from '../../../shared/conversation/composerResource'
import type { ApplicationDiagnostic } from '../../../shared/diagnostics/applicationDiagnostic'
import type { ReusableBuddySession } from '../agent/sessions/ReusableBuddySession'
import type { BuddyServiceRpcServer } from '../rpc/BuddyServiceRpcServer'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it } from 'vitest'

import { createBuddyUserContent } from '../../../shared/conversation/buddyUserContent'
import { createBuddyInputReference } from '../agent/context/BuddyInputReference'
import { PiEventBridge } from '../agent/events/PiEventBridge'
import { BuddyAgentRunner } from '../agent/execution/BuddyAgentRunner'
import { PiTurnExecutor } from '../agent/execution/PiTurnExecutor'
import { BuddySessionRegistry } from '../agent/sessions/BuddySessionRegistry'
import { inspectCommittedPiCompaction } from '../agent/sessions/recovery/inspectCommittedPiCompaction'
import { ApprovalService } from '../approvals/ApprovalService'
import { startBuddyService } from '../BuddyService'
import { createRunEventLog } from '../events/createRunEventLog'
import { PermissionEngine } from '../permissions/PermissionEngine'
import { RunLifecycleService } from '../runs/RunLifecycleService'
import { RunRecoveryService } from '../runs/RunRecoveryService'
import {
  prepareTestCommandRequest,
  prepareTestTurnRequest,
} from '../storage/__tests__/composerDraftTestFixture'
import { createApprovalRepository } from '../storage/approvalRepository'
import { createAttachmentRepository } from '../storage/attachmentRepository'
import { createConversationRepository } from '../storage/conversationRepository'
import { openBuddyDatabase } from '../storage/database'
import { createRunRepository } from '../storage/runRepository'
import { createSpaceRepository } from '../storage/spaceRepository'
import { createUsageRepository } from '../storage/usageRepository'
import { UsageService } from '../usage/UsageService'

const databases: DatabaseSync[] = []
const directories: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer))
  for (const database of databases.splice(0))
    database.close()
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('buddy runtime cross-subsystem contract', () => {
  it('persists a Pi-backed run, enforces its directory grant, approves risky work and replays JSONL', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-integration-')))
    directories.push(root)
    const spaceRoot = join(root, 'space')
    const conversationsDirectory = join(root, 'conversations')
    const eventsDirectory = join(conversationsDirectory, 'conversation-1', 'events')
    const databasePath = join(root, 'buddy.sqlite3')
    await mkdir(spaceRoot)

    const database = openTrackedDatabase(databasePath)
    let resolveApprovalRequested!: () => void
    const approvalRequested = new Promise<void>((resolve) => {
      resolveApprovalRequested = resolve
    })
    const eventLog = createRunEventLog({
      conversationsDirectory,
      database,
      onEvent(event) {
        if (event.type === 'approval.requested')
          resolveApprovalRequested()
      },
    })
    createSpaceRepository(database).create({
      additionalDirectories: [],
      createdAt: '2026-08-14T00:00:00.000Z',
      id: 'space-1',
      memoryScope: 'personal_and_space',
      name: 'Integration Space',
      primaryDirectory: {
        accessGrantedAt: '2026-08-14T00:00:00.000Z',
        canonicalRoot: spaceRoot,
        id: 'directory-1',
        resourcesTrustedAt: '2026-08-14T00:00:00.000Z',
        root: spaceRoot,
      },
    })
    const conversations = createConversationRepository(database)
    const runs = createRunRepository(database)
    const usageRepository = createUsageRepository(database)
    const usage = new UsageService({ eventLog, repository: usageRepository })
    const session = new OfflinePiSession(join(spaceRoot, 'article.md'))
    const sessions = new BuddySessionRegistry<ReusableBuddySession>()
    const piEvents = new PiEventBridge({ eventLog, usage })
    const runner = new BuddyAgentRunner({
      executor: new PiTurnExecutor({
        eventLog,
        piEvents,
        runs,
        sessionFactory: async () => ({
          piSessionFile: join(root, 'pi-session.jsonl'),
          session,
        }),
        sessions,
      }),
      lifecycle: new RunLifecycleService({ eventLog, repository: runs }),
      sessions,
    })

    const turnInput = {
      model: 'claude-sonnet-4-5',
      prompt: 'Write the article',
      provider: 'anthropic',
      runId: 'run-1',
      userInput: createBuddyInputReference({
        images: [],
        messageId: 'message-1',
        prompt: 'Write the article',
      }),
      session: {
        branchId: 'branch-1',
        canonicalRoot: spaceRoot,
        conversationId: 'conversation-1',
        approvalPolicy: 'policy' as const,
        executionProfile: 'workspace_write' as const,
        grantRevision: 'grants-1',
        grants: [{ canonicalRoot: spaceRoot, grantId: 'directory-1', kind: 'workspace' as const, root: spaceRoot }],
        resources: {
          skillReadRoots: [],
          skillReferences: [],
          approvedSkillPaths: [],
          context: { agentsFiles: [], diagnostics: [] },
          directoryContext: '',
          revision: 'resources-1',
        },
        scratchRoot: spaceRoot,
        sessionMode: 'interactive' as const,
        space: {
          additionalDirectoryBindings: [],
          id: 'space-1',
          memoryScope: 'personal_and_space' as const,
          primaryDirectoryBinding: { id: 'directory-1', revision: 1 },
        },
      },
    }
    prepareTestTurnRequest(database, {
      attachmentBindings: [],
      branchId: turnInput.session.branchId,
      conversationId: turnInput.session.conversationId,
      createdAt: '2026-08-14T00:00:00.000Z',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      model: turnInput.model,
      spaceId: turnInput.session.space.id,
      provider: turnInput.provider,
      requestFingerprint: 'fingerprint-1',
      requestId: 'request-1',
      runInput: {
        attachmentIds: [],
        contextItems: [],
        prompt: turnInput.prompt,
        reasoning: null,
        serviceTier: null,
      },
      runId: turnInput.runId,
      title: null,
      userMessageContent: { text: turnInput.prompt },
      userMessageId: 'message-1',
    })
    const run = await runner.startTurn(turnInput).completion

    expect(run).toMatchObject({ piSessionFile: join(root, 'pi-session.jsonl'), status: 'completed' })
    expect(conversations.listMessages('conversation-1', 'branch-1').map(message => message.role))
      .toEqual(['user', 'assistant', 'tool'])
    expect(usageRepository.listForRun('run-1')).toHaveLength(2)

    const policy = new PermissionEngine()
    const grants = [{ canonicalRoot: spaceRoot, grantId: 'directory-1', kind: 'workspace' as const, root: spaceRoot }]
    await expect(policy.decide({
      approvalPolicy: 'policy',
      arguments: { content: 'safe', path: join(spaceRoot, 'safe.md') },
      approvalAvailable: true,
      cwd: spaceRoot,
      grants,
      owner: { id: 'space-1', kind: 'space' },
      profile: 'workspace_write',
      toolName: 'write',
    })).resolves.toEqual({ type: 'allow' })
    await expect(policy.decide({
      approvalPolicy: 'policy',
      arguments: { content: 'blocked', path: join(root, 'outside.md') },
      approvalAvailable: true,
      cwd: spaceRoot,
      grants,
      owner: { id: 'space-1', kind: 'space' },
      profile: 'workspace_write',
      toolName: 'write',
    })).resolves.toMatchObject({ grant: { owner: { kind: 'space' } }, kind: 'write', type: 'ask' })
    await expect(policy.decide({
      approvalPolicy: 'policy',
      arguments: { command: 'python transform.py' },
      approvalAvailable: true,
      cwd: spaceRoot,
      grants,
      owner: { id: 'space-1', kind: 'space' },
      profile: 'workspace_write',
      toolName: 'bash',
    })).resolves.toMatchObject({ kind: 'shell', type: 'ask' })

    const approvals = createApprovalRepository(database)
    const approvalService = new ApprovalService({ eventLog, repository: approvals })
    const pendingDecision = approvalService.request({
      reuseScopes: ['operation', 'source', 'turn'],
      arguments: { command: 'python transform.py' },
      kind: 'shell',
      runId: 'run-1',
      signal: new AbortController().signal,
      summary: 'Run a local transform',
      toolCallId: 'tool-shell-1',
      toolName: 'bash',
    })
    await approvalRequested
    const pending = approvals.listPending('run-1')[0]
    expect(await approvalService.resolve({ decision: 'approved', id: pending.id }))
      .toMatchObject({ status: 'approved' })
    await expect(pendingDecision).resolves.toEqual({
      approvalId: pending.id,
      decision: 'approved_once',
    })

    const sourceEvents = await eventLog.read('run-1')
    expect(sourceEvents.map(event => event.sequence)).toEqual(
      expect.arrayContaining([1, 2, 4, 5, 8, 9, 10]),
    )
    expect(sourceEvents.every((event, index, all) => index === 0 || event.sequence > all[index - 1]!.sequence))
      .toBe(true)
    expect(sourceEvents.map(event => event.type)).toEqual(expect.arrayContaining([
      'run.started',
      'usage.recorded',
      'run.completed',
      'approval.requested',
      'approval.resolved',
    ]))
    expect((await readFile(join(eventsDirectory, 'run-1.jsonl'), 'utf8')).trim().split('\n'))
      .toHaveLength(sourceEvents.length)

    await runner.dispose()
    await eventLog.close()
    database.close()
    databases.splice(databases.indexOf(database), 1)

    const recoveredDatabase = openTrackedDatabase(databasePath)
    recoveredDatabase.exec(`
      DELETE FROM run_events;
      UPDATE runs SET status = 'running', completed_at = NULL WHERE id = 'run-1';
    `)
    const recoveredLog = createRunEventLog({ conversationsDirectory, database: recoveredDatabase })
    await expect(recoveredLog.replay('run-1')).resolves.toBe(sourceEvents.length)
    expect(recoveredDatabase.prepare('SELECT COUNT(*) AS count FROM run_events').get())
      .toEqual({ count: sourceEvents.length })
    expect(createRunRepository(recoveredDatabase).findById('run-1')?.status).toBe('completed')
    await recoveredLog.close()
  })

  it('recovers readable historical images and publishes one sanitized degradation after Pi corruption', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-attachment-recovery-')))
    directories.push(root)
    const buddyHome = join(root, 'buddy')
    const builtinSkillsDirectory = join(root, 'skills')
    const keptSource = join(root, 'kept.png')
    const missingSource = join(root, 'missing.png')
    const keptBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    await Promise.all([
      mkdir(builtinSkillsDirectory, { recursive: true }),
      writeFile(keptSource, keptBytes),
      writeFile(missingSource, keptBytes),
    ])
    const database = openTrackedDatabase(join(buddyHome, 'buddy.sqlite3'))
    const eventLog = createRunEventLog({
      conversationsDirectory: join(buddyHome, 'conversations'),
      database,
    })
    const provider = await startLocalModelProvider()
    const credentials = {
      'offline-provider': { key: 'test-api-key', type: 'api_key' as const },
    }
    const diagnostics: ApplicationDiagnostic[] = []
    let runtime: Awaited<ReturnType<typeof startBuddyService>> | undefined
    try {
      let harness = createRuntimeRpcHarness(credentials)
      runtime = await startBuddyService({
        record: event => diagnostics.push(event),
        buddyHome,
        builtinSkillsDirectories: [builtinSkillsDirectory],
        database,
        eventLog,
        rpc: harness.rpc,
      })
      await harness.invoke('providers.upsertCustom', offlineProviderConfig(provider.baseUrl))
      await turnRequest(harness, { content: 'Remember both historical images', requestId: 'attachment-recovery-1' })
      await harness.invoke('composerResources.accept', {
        draftId: 'draft-attachment-recovery-1',
        resources: [keptSource, missingSource].map((sourcePath, index) => ({ resourceId: `recovery-${index}`, name: `recovery-${index}.png`, mimeType: 'image/png', sizeBytes: keptBytes.length, sourcePath, storage: 'snapshot' })),
      })
      const attachments = await Promise.all([0, 1].map(index => harness.invoke('composerResources.complete', { draftId: 'draft-attachment-recovery-1', resourceId: `recovery-${index}`, bytes: Uint8Array.from(keptBytes) }))) as ReadonlyArray<BuddyComposerResource>
      expect(attachments).toHaveLength(2)
      const attachmentIds = attachments.map((resource) => {
        if (resource.state !== 'ready' || !('attachmentId' in resource))
          throw new Error('Expected a ready imported resource')
        return resource.attachmentId
      })
      const messageAttachments = attachments.map((resource, index) => ({
        attachmentId: attachmentIds[index]!,
        kind: resource.kind,
        mimeType: resource.mimeType,
        name: resource.name,
        previewUrl: null,
        sizeBytes: resource.sizeBytes,
      }))

      const firstTurn = await harness.invoke('chat.startTurn', await turnRequest(harness, {
        resourceIds: attachments.map(attachment => attachment.resourceId),
        content: 'Remember both historical images',
        requestId: 'attachment-recovery-1',
      })) as LocalTurnStart
      await expect(waitForTerminalRun(harness, firstTurn.runId)).resolves.toMatchObject({
        status: 'completed',
      })
      expect(readDataImageUrls(provider.requests[0])).toHaveLength(2)
      const timeline = await harness.invoke('conversations.listTimeline', {
        branchId: firstTurn.branchId,
        conversationId: firstTurn.conversationId,
        limit: 100,
      }) as {
        items: ReadonlyArray<{
          attachments?: ReadonlyArray<LocalAttachment>
          content: unknown
          kind: 'message'
          role: 'assistant' | 'tool' | 'user'
        }>
        outputs: readonly unknown[]
        runEvents: ReadonlyArray<LocalRunEvent>
        runs: ReadonlyArray<LocalRun>
      }
      expect(timeline.items.find(item => item.kind === 'message' && item.role === 'user'))
        .toMatchObject({
          attachments: messageAttachments,
          content: {
            resourceSnapshots: attachmentIds.map((attachmentId, index) => ({
              attachmentId,
              resourceId: attachments[index]!.resourceId,
            })),
            userContent: {
              body: [{
                content: [{ text: 'Remember both historical images', type: 'text' }],
                type: 'paragraph',
              }],
              panelResourceIds: attachments.map(attachment => attachment.resourceId),
              version: 1,
            },
          },
        })
      expect(timeline.runs).toContainEqual(expect.objectContaining({ id: firstTurn.runId }))
      expect(timeline.outputs).toEqual([])
      expect(timeline.runEvents).toContainEqual(expect.objectContaining({
        runId: firstTurn.runId,
        type: 'run.completed',
      }))

      const firstRun = createRunRepository(database).findById(firstTurn.runId)
      if (!firstRun?.piSessionFile)
        throw new Error('The first run did not bind a Pi session')
      const missingAttachmentId = attachmentIds[1]!
      const missingAttachment = createAttachmentRepository(database).findById(missingAttachmentId)
      if (!missingAttachment)
        throw new Error('The missing attachment was not persisted')

      await runtime.dispose()
      runtime = undefined
      await Promise.all([
        writeFile(firstRun.piSessionFile, '{broken jsonl}\n'),
        unlink(missingAttachment.storedPath),
      ])

      harness = createRuntimeRpcHarness(credentials)
      runtime = await startBuddyService({
        record: event => diagnostics.push(event),
        buddyHome,
        builtinSkillsDirectories: [builtinSkillsDirectory],
        database,
        eventLog,
        rpc: harness.rpc,
      })
      const secondTurn = await harness.invoke('chat.startTurn', await turnRequest(harness, {
        branchId: firstTurn.branchId,
        content: 'Continue after recovery',
        conversationId: firstTurn.conversationId,
        requestId: 'attachment-recovery-2',
      })) as LocalTurnStart
      await expect(waitForTerminalRun(harness, secondTurn.runId)).resolves.toMatchObject({
        status: 'completed',
      })
      for (const turn of [firstTurn, secondTurn]) {
        const related = diagnostics.filter(event => event.runId === turn.runId)
        for (const event of ['run.queued', 'run.started', 'turn.started', 'turn.completed', 'run.completed'])
          expect(related).toContainEqual(expect.objectContaining({ event, conversationId: turn.conversationId, branchId: turn.branchId }))
        expect(related).toContainEqual(expect.objectContaining({ event: 'turn.completed', turnId: `${turn.runId}:1` }))
      }
      for (const content of ['Remember both historical images', 'Continue after recovery', 'test-api-key', keptBytes.toString('base64')])
        expect(JSON.stringify(diagnostics)).not.toContain(content)
      expect(readDataImageUrls(provider.requests[1])).toEqual([
        `data:image/png;base64,${keptBytes.toString('base64')}`,
      ])

      const internalEvents = await eventLog.read(secondTurn.runId)
      expect(internalEvents.filter(event => event.type === 'session.recovery.degraded'))
        .toMatchObject([{
          payload: {
            missingAttachmentCount: 1,
            missingAttachmentIds: [missingAttachmentId],
            recoveredImageCount: 1,
            source: 'sqlite',
          },
        }])
      const publicEvents = await harness.invoke('runs.listEvents', {
        limit: 100,
        runId: secondTurn.runId,
      }) as ReadonlyArray<LocalRunEvent>
      expect(publicEvents.filter(event => event.type === 'session.recovery.degraded'))
        .toMatchObject([{
          payload: {
            missingAttachmentCount: 1,
            recoveredImageCount: 1,
            source: 'sqlite',
          },
        }])
      expect(JSON.stringify(publicEvents)).not.toContain(missingAttachmentId)
      expect(JSON.stringify(publicEvents)).not.toContain(missingAttachment.storedPath)

      const thirdTurn = await harness.invoke('chat.startTurn', await turnRequest(harness, {
        branchId: firstTurn.branchId,
        content: 'Reuse the recovered session',
        conversationId: firstTurn.conversationId,
        requestId: 'attachment-recovery-3',
      })) as LocalTurnStart
      await expect(waitForTerminalRun(harness, thirdTurn.runId)).resolves.toMatchObject({
        status: 'completed',
      })
      expect((await eventLog.read(thirdTurn.runId)).filter(event => event.type.startsWith('session.')))
        .toEqual([])
    }
    finally {
      await runtime?.dispose()
      await eventLog.close()
    }
  })

  it('reconciles a Pi-committed compaction into Buddy storage after a runtime crash', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-recovery-')))
    directories.push(root)
    const conversationsDirectory = join(root, 'conversations')
    const sessionDirectory = join(
      conversationsDirectory,
      'conversation-1',
      'session',
      'branch-1',
    )
    await mkdir(sessionDirectory, { recursive: true })
    const manager = SessionManager.create(root, sessionDirectory)
    const firstKeptEntryId = manager.appendMessage({
      content: 'Keep this context',
      role: 'user',
      timestamp: Date.now(),
    })
    manager.appendMessage(assistant('Kept response'))
    manager.appendCompaction(
      'Private compacted context',
      firstKeptEntryId,
      1_200,
      undefined,
      false,
      usage(30, 6),
    )
    const piSessionFile = manager.getSessionFile()
    if (!piSessionFile)
      throw new Error('Pi did not create a persistent session file')

    const database = openTrackedDatabase(join(root, 'buddy.sqlite3'))
    const eventLog = createRunEventLog({ conversationsDirectory, database })
    const conversations = createConversationRepository(database)
    const runs = createRunRepository(database)
    const inspectCommittedCompaction = (run: NonNullable<ReturnType<typeof runs.findById>>) =>
      run.piSessionFile
        ? inspectCommittedPiCompaction({
            branchId: run.branchId,
            conversationsDirectory,
            conversationId: run.conversationId,
            piSessionFile: run.piSessionFile,
            startedAt: run.startedAt,
          })
        : Promise.resolve(null)
    prepareTestTurnRequest(database, {
      attachmentBindings: [],
      branchId: 'branch-1',
      conversationId: 'conversation-1',
      createdAt: '2026-08-15T00:00:00.000Z',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      model: 'model-1',
      spaceId: null,
      provider: 'provider-1',
      requestFingerprint: 'fingerprint-source',
      requestId: 'request-source',
      runInput: {
        attachmentIds: [],
        contextItems: [],
        prompt: 'Original turn',
        reasoning: null,
        serviceTier: null,
      },
      runId: 'run-source',
      title: null,
      userMessageContent: { text: 'Original turn' },
      userMessageId: 'message-source',
    })
    database.prepare(`
      UPDATE runs
      SET status = 'completed', pi_session_file = ?, completed_at = ?
      WHERE id = 'run-source'
    `).run(piSessionFile, '2026-08-15T00:00:01.000Z')
    prepareTestCommandRequest(database, {
      arguments: '',
      branchId: 'branch-1',
      command: 'compact',
      conversationId: 'conversation-1',
      createdAt: '2026-08-15T00:00:02.000Z',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      requestFingerprint: 'fingerprint-compact',
      requestId: 'request-compact',
      runId: 'run-compact',
    })
    database.prepare(`
      UPDATE runs SET status = 'running' WHERE id = 'run-compact'
    `).run()
    const usageRepository = createUsageRepository(database)
    const lifecycle = new RunLifecycleService({ eventLog, repository: runs })
    const recovery = new RunRecoveryService({
      conversations,
      eventLog,
      inspectCommittedCompaction,
      lifecycle,
      repository: runs,
      usage: new UsageService({ eventLog, repository: usageRepository }),
    })

    expect(await recovery.recoverInterruptedRuns()).toBe(1)
    expect(runs.findById('run-compact')).toMatchObject({ status: 'completed' })
    expect((await eventLog.read('run-compact')).map(event => event.type)).toEqual([
      'context.compaction.completed',
      'usage.recorded',
      'run.completed',
    ])
    expect(usageRepository.listForRun('run-compact')).toHaveLength(1)
    expect(conversations.listTimelinePage(
      'conversation-1',
      'branch-1',
      { limit: 10 },
    ).items.find(item => item.id === 'run-compact')).toMatchObject({
      estimatedTokensAfter: expect.any(Number),
      kind: 'compaction',
      status: 'completed',
      tokensBefore: 1_200,
    })
    expect(JSON.stringify(await eventLog.read('run-compact')))
      .not
      .toContain('Private compacted context')
  })

  it('rebuilds usage from events and compacts terminal event history before startup', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-startup-')))
    directories.push(root)
    const buddyHome = join(root, 'buddy')
    const builtinSkillsDirectory = join(root, 'skills')
    await mkdir(builtinSkillsDirectory, { recursive: true })
    const database = openTrackedDatabase(join(buddyHome, 'buddy.sqlite3'))
    const eventLog = createRunEventLog({
      conversationsDirectory: join(buddyHome, 'conversations'),
      database,
    })
    prepareTestTurnRequest(database, {
      attachmentBindings: [],
      branchId: 'branch-1',
      conversationId: 'conversation-1',
      createdAt: '2026-08-15T00:00:00.000Z',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      model: 'model-1',
      spaceId: null,
      provider: 'provider-1',
      requestFingerprint: 'fingerprint-startup',
      requestId: 'request-startup',
      runInput: {
        attachmentIds: [],
        contextItems: [],
        prompt: 'Original turn',
        reasoning: null,
        serviceTier: null,
      },
      runId: 'run-startup',
      title: null,
      userMessageContent: { text: 'Original turn' },
      userMessageId: 'message-startup',
    })
    database.prepare(`
      UPDATE runs SET status = 'completed', completed_at = ? WHERE id = 'run-startup'
    `).run('2026-08-15T00:00:02.000Z')
    await eventLog.append({
      payload: { delta: 'Recovered', messageId: 'assistant-startup' },
      runId: 'run-startup',
      type: 'message.delta',
    })
    await eventLog.append({
      payload: {
        content: { text: 'Recovered' },
        messageId: 'assistant-startup',
        role: 'assistant',
        stopReason: 'completed',
      },
      runId: 'run-startup',
      type: 'message.completed',
    })
    const usageRepository = createUsageRepository(database)
    await eventLog.append({
      createdAt: '2026-08-15T00:00:01.000Z',
      payload: {
        cacheReadCost: 0,
        cacheReadTokens: 0,
        cacheWriteCost: 0,
        cacheWriteTokens: 0,
        inputCost: 0.01,
        inputTokens: 10,
        model: 'model-1',
        outputCost: 0.02,
        outputTokens: 5,
        provider: 'provider-1',
        purpose: 'turn',
        reasoningTokens: null,
        sourceEntryId: 'pi-entry-startup',
        totalCost: 0.03,
        totalTokens: 15,
        usageRecordId: 'usage-startup',
      },
      runId: 'run-startup',
      type: 'usage.recorded',
    })
    await eventLog.append({ payload: {}, runId: 'run-startup', type: 'run.completed' })
    database.exec(`
      DELETE FROM run_events WHERE run_id = 'run-startup';
      DELETE FROM usage_records WHERE run_id = 'run-startup';
    `)
    await expect(eventLog.replayAll()).resolves.toBe(4)
    expect(usageRepository.findBySource('run-startup', 'pi-entry-startup', 'turn'))
      .toMatchObject({
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        createdAt: '2026-08-15T00:00:01.000Z',
        id: 'usage-startup',
        inputTokens: 10,
        model: 'model-1',
        outputTokens: 5,
        provider: 'provider-1',
        purpose: 'turn',
        reasoningTokens: null,
        runId: 'run-startup',
        sourceEntryId: 'pi-entry-startup',
        totalCost: 0.03,
        totalTokens: 15,
      })

    const environment = { ...process.env }
    let runtime: Awaited<ReturnType<typeof startBuddyService>> | undefined
    try {
      runtime = await startBuddyService({
        buddyHome,
        builtinSkillsDirectories: [builtinSkillsDirectory],
        database,
        eventLog,
        rpc: createRuntimeRpcStub(),
      })

      expect((await eventLog.read('run-startup')).map(event => event.type))
        .toEqual(['message.completed', 'usage.recorded', 'run.completed'])
      expect(createRunRepository(database).findById('run-startup')).toMatchObject({
        status: 'completed',
      })
    }
    finally {
      await runtime?.dispose()
      restoreEnvironment(environment)
    }
  })

  it('withdraws registered runtime capabilities when startup fails', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-startup-failure-')))
    directories.push(root)
    const buddyHome = join(root, 'buddy')
    const builtinSkillsDirectory = join(root, 'skills')
    await mkdir(builtinSkillsDirectory, { recursive: true })
    const database = openTrackedDatabase(join(buddyHome, 'buddy.sqlite3'))
    const eventLog = createRunEventLog({
      conversationsDirectory: join(buddyHome, 'conversations'),
      database,
    })
    const harness = createRuntimeRpcHarness()

    try {
      await expect(startBuddyService({
        automationClock: {
          now() { throw new Error('Scheduler clock unavailable') },
        },
        buddyHome,
        builtinSkillsDirectories: [builtinSkillsDirectory],
        database,
        eventLog,
        rpc: harness.rpc,
      })).rejects.toThrow('Scheduler clock unavailable')
      await expect(harness.invoke('usage.snapshot', {}))
        .rejects
        .toThrow('Runtime handler is unavailable: usage.snapshot')
    }
    finally {
      await eventLog.close()
    }
  })

  it('builds a read-only context snapshot through the runtime capability', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-context-usage-')))
    directories.push(root)
    const buddyHome = join(root, 'buddy')
    const builtinSkillsDirectory = join(root, 'skills')
    await mkdir(builtinSkillsDirectory, { recursive: true })
    const database = openTrackedDatabase(join(buddyHome, 'buddy.sqlite3'))
    const eventLog = createRunEventLog({
      conversationsDirectory: join(buddyHome, 'conversations'),
      database,
    })
    const provider = await startLocalModelProvider()
    const harness = createRuntimeRpcHarness({
      'offline-provider': { key: 'test-api-key', type: 'api_key' },
    })
    const runtime = await startBuddyService({
      buddyHome,
      builtinSkillsDirectories: [builtinSkillsDirectory],
      database,
      eventLog,
      rpc: harness.rpc,
    })

    try {
      await harness.invoke('providers.upsertCustom', offlineProviderConfig(provider.baseUrl))
      const request = {
        branchId: null,
        conversationId: null,
        draftId: 'draft-context-usage',
        approvalPolicy: 'policy' as const,
        executionProfile: 'workspace_write',
        modelSelection: {
          modelId: 'offline-model',
          providerId: 'offline-provider',
          reasoning: null,
          serviceTier: null,
        },
        spaceId: null,
      }
      const snapshot = await harness.invoke(
        'context.usageSnapshot',
        request,
      ) as LocalContextUsageSnapshot

      if (snapshot.status !== 'ready')
        throw new Error('Expected a ready draft context snapshot')
      expect(snapshot).toMatchObject({
        contextWindow: 16_384,
        modelId: 'offline-model',
        providerId: 'offline-provider',
      })
      expect(Date.parse(snapshot.createdAt)).not.toBeNaN()
      expect(
        snapshot.mcpTokens
        + snapshot.messageTokens
        + snapshot.skillTokens
        + snapshot.systemPromptTokens
        + snapshot.toolTokens,
      ).toBe(snapshot.totalTokens)
      expect(provider.requests).toEqual([])
      expect(createConversationRepository(database).listRecent()).toEqual([])
      expect(createRunRepository(database).listRecent()).toEqual([])
      await expect(harness.invoke('context.usageSnapshot', {
        ...request,
        branchId: 'branch-without-conversation',
      })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    }
    finally {
      await runtime.dispose()
      await eventLog.close()
    }
  })

  it('forks edited and regenerated chat turns while preserving idempotent replay', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-chat-turns-')))
    directories.push(root)
    const buddyHome = join(root, 'buddy')
    const builtinSkillsDirectory = join(root, 'skills')
    await mkdir(builtinSkillsDirectory, { recursive: true })
    const database = openTrackedDatabase(join(buddyHome, 'buddy.sqlite3'))
    const eventLog = createRunEventLog({
      conversationsDirectory: join(buddyHome, 'conversations'),
      database,
    })
    const provider = await startLocalModelProvider()
    const harness = createRuntimeRpcHarness({
      'offline-provider': { key: 'test-api-key', type: 'api_key' },
    })
    const service = await startBuddyService({
      buddyHome,
      builtinSkillsDirectories: [builtinSkillsDirectory],
      database,
      eventLog,
      rpc: harness.rpc,
    })

    try {
      await harness.invoke('providers.upsertCustom', offlineProviderConfig(provider.baseUrl))
      const first = await service.runtime.startTurn(await turnRequest(harness, {
        content: 'Original user input',
        requestId: 'chat-fork-start',
      }))
      await expect(waitForTerminalRun(harness, first.runId)).resolves.toMatchObject({
        status: 'completed',
      })
      const conversations = createConversationRepository(database)
      const firstMessages = conversations.listBranchMessages(
        first.conversationId,
        first.branchId,
      )
      const sourceUser = firstMessages.find(message => message.role === 'user')
      if (!sourceUser)
        throw new Error('The source user message was not persisted')

      const editContent = createBuddyUserContent('Edited user input')
      const editDraft = await harness.invoke('composerDrafts.open', {
        draftId: 'draft-chat-fork-edit',
        initialContent: editContent,
        initialExecutionConfig: {
          approvalPolicy: 'policy',
          executionProfile: 'workspace_write',
        },
        initialModelSelection: {
          modelId: 'offline-model',
          providerId: 'offline-provider',
          reasoning: null,
          serviceTier: null,
        },
        scope: {
          branchId: first.branchId,
          conversationId: first.conversationId,
          kind: 'message_edit',
          userMessageId: sourceUser.id,
        },
      }) as { draftId: string, revision: number }
      const edited = await harness.invoke('chat.editUserMessage', {
        conversationId: first.conversationId,
        draftId: editDraft.draftId,
        expectedRevision: editDraft.revision,
        requestId: 'chat-fork-edit',
        userMessageId: sourceUser.id,
      }) as LocalTurnStart
      expect(edited.branchId).not.toBe(first.branchId)
      await expect(waitForTerminalRun(harness, edited.runId)).resolves.toMatchObject({
        status: 'completed',
      })
      const editedMessages = conversations.listBranchMessages(
        edited.conversationId,
        edited.branchId,
      )
      expect(editedMessages.find(message => message.role === 'user')?.content).toMatchObject({
        userContent: {
          body: [{ content: [{ text: 'Edited user input', type: 'text' }] }],
        },
      })
      const editedAssistant = editedMessages.find(message => message.role === 'assistant')
      if (!editedAssistant)
        throw new Error('The edited assistant message was not persisted')

      const regenerationRequest = {
        conversationId: edited.conversationId,
        requestId: 'chat-fork-regenerate',
        sourceRunId: edited.runId,
      }
      const regenerated = await harness.invoke(
        'chat.regenerateAssistant',
        regenerationRequest,
      ) as LocalTurnStart
      expect(regenerated.branchId).not.toBe(edited.branchId)
      await expect(waitForTerminalRun(harness, regenerated.runId)).resolves.toMatchObject({
        status: 'completed',
      })
      const replayed = await harness.invoke(
        'chat.regenerateAssistant',
        regenerationRequest,
      ) as LocalTurnStart

      expect(replayed).toMatchObject({
        branchId: regenerated.branchId,
        conversationId: regenerated.conversationId,
        runId: regenerated.runId,
      })
      expect(provider.requests).toHaveLength(3)
      expect(JSON.stringify(provider.requests[1])).toContain('Edited user input')
      expect(JSON.stringify(provider.requests[2])).toContain('Edited user input')
      expect(conversations.listBranches(first.conversationId)).toHaveLength(3)
      expect(conversations.listBranchMessages(first.conversationId, first.branchId)
        .find(message => message.role === 'user')
        ?.content).toMatchObject({
        userContent: {
          body: [{ content: [{ text: 'Original user input', type: 'text' }] }],
        },
      })
    }
    finally {
      await service.dispose()
      await eventLog.close()
    }
  })

  it('executes a short once automation as a visible unbound conversation', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-automation-runtime-')))
    directories.push(root)
    const buddyHome = join(root, 'buddy')
    const builtinSkillsDirectory = join(root, 'skills')
    await mkdir(builtinSkillsDirectory, { recursive: true })
    const database = openTrackedDatabase(join(buddyHome, 'buddy.sqlite3'))
    const eventLog = createRunEventLog({
      conversationsDirectory: join(buddyHome, 'conversations'),
      database,
    })
    const provider = await startLocalModelProvider()
    const harness = createRuntimeRpcHarness({
      'offline-provider': { key: 'test-api-key', type: 'api_key' },
    })
    let now = Temporal.Instant.from('2026-08-24T01:00:00.000Z')
    const runtime = await startBuddyService({
      automationClock: { now: () => now },
      buddyHome,
      builtinSkillsDirectories: [builtinSkillsDirectory],
      database,
      eventLog,
      rpc: harness.rpc,
    })

    try {
      await harness.invoke('providers.upsertCustom', offlineProviderConfig(provider.baseUrl))
      const automation = await harness.invoke('automations.create', {
        draft: {
          model: {
            mode: 'pinned',
            modelId: 'offline-model',
            providerId: 'offline-provider',
            reasoning: null,
          },
          name: 'Short once integration',
          spaceId: null,
          prompt: 'Run the short once integration task',
          timing: {
            activeFrom: null,
            activeUntil: null,
            schedule: { kind: 'once', runAt: '2026-08-24T01:00:01.000Z' },
            timezone: 'Asia/Shanghai',
          },
        },
        requestId: 'create-short-once-integration',
      }) as LocalAutomation

      expect(automation).toMatchObject({
        nextRunAt: '2026-08-24T01:00:01.000Z',
        revision: 1,
        status: 'active',
      })

      now = Temporal.Instant.from('2026-08-24T01:00:02.000Z')
      harness.notifyRuntime('scheduler.wake', { reason: 'resume' })
      const occurrence = await waitForAutomationOccurrence(harness, automation.id)

      expect(occurrence).toMatchObject({
        automationId: automation.id,
        automationName: 'Short once integration',
        automationRevision: 1,
        coalescedMissedCount: 0,
        effectiveStatus: 'completed',
        status: 'bound',
        triggerKind: 'scheduled',
      })
      expect(occurrence.conversationId).not.toBeNull()
      expect(occurrence.runId).not.toBeNull()
      const run = await harness.invoke('runs.get', { runId: occurrence.runId }) as LocalRun
      expect(run).toMatchObject({
        conversationId: occurrence.conversationId,
        approvalPolicy: 'policy' as const,
        executionProfile: 'workspace_write',
        purpose: 'automation',
        status: 'completed',
      })
      const conversation = await harness.invoke('conversations.get', {
        conversationId: occurrence.conversationId,
      }) as { id: string, origin?: string, spaceId: string | null }
      expect(conversation).toMatchObject({
        id: occurrence.conversationId,
        origin: 'automation',
        spaceId: null,
      })
      const persistedAutomation = await harness.invoke('automations.get', {
        automationId: automation.id,
      }) as LocalAutomation
      expect(persistedAutomation).toMatchObject({
        spaceId: null,
        revision: 1,
      })
      const spaces = await harness.invoke('spaces.list', {}) as ReadonlyArray<{
        id: string
        name: string
      }>
      expect(spaces).toEqual([])
      const recent = await harness.invoke('conversations.list', {}) as ReadonlyArray<{
        automationOccurrence: { occurrenceId: string } | null
        id: string
      }>
      expect(recent).toContainEqual(expect.objectContaining({
        automationOccurrence: expect.objectContaining({ occurrenceId: occurrence.id }),
        id: occurrence.conversationId,
      }))
      const notificationList = await harness.invoke('notifications.list', {}) as LocalNotificationList
      expect(notificationList).toMatchObject({
        items: [{
          action: {
            conversationId: occurrence.conversationId,
            runId: occurrence.runId,
            type: 'open-conversation',
          },
          attention: 'unseen',
          kind: 'automation.run.completed',
          payload: {
            automationId: automation.id,
            automationName: 'Short once integration',
            errorCode: null,
          },
        }],
        unseenCount: 1,
      })
      expect(provider.requests).toHaveLength(1)
      expect(harness.notifications).toContainEqual({
        method: 'automation.changed',
        params: { automationId: automation.id },
      })
    }
    finally {
      await runtime.dispose()
      await eventLog.close()
    }
  })
})

class OfflinePiSession implements ReusableBuddySession {
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>()
  readonly #target: string

  constructor(target: string) {
    this.#target = target
  }

  abort(): Promise<void> {
    return Promise.resolve()
  }

  abortCompaction(): void {}

  canCompact(): boolean {
    return true
  }

  activateTurn(): Promise<() => void> {
    return Promise.resolve(() => {})
  }

  shutdown(): Promise<void> {
    return Promise.resolve()
  }

  compact(): Promise<CompactionResult> {
    return Promise.reject(new Error('not used'))
  }

  async prompt(): Promise<void> {
    const assistantMessage = assistant('I will create the article')
    this.#emit({ type: 'message_start', message: assistantMessage })
    this.#emit({ type: 'message_end', message: assistantMessage })
    this.#emit({ type: 'entry_appended', entry: entry('pi-assistant-1', assistantMessage) })
    this.#emit({
      type: 'tool_execution_start',
      toolCallId: 'tool-write-1',
      toolName: 'write',
      args: { content: 'Article', path: this.#target },
    })
    await writeFile(this.#target, 'Article')
    this.#emit({
      type: 'tool_execution_end',
      toolCallId: 'tool-write-1',
      toolName: 'write',
      result: { content: [{ type: 'text', text: 'written' }] },
      isError: false,
    })
    const toolMessage: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: 'tool-write-1',
      toolName: 'write',
      content: [{ type: 'text', text: 'written' }],
      isError: false,
      timestamp: Date.now(),
      usage: usage(2, 1),
    }
    this.#emit({ type: 'message_end', message: toolMessage })
    this.#emit({ type: 'entry_appended', entry: entry('pi-tool-1', toolMessage) })
    this.#emit({ type: 'agent_settled' })
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  waitForIdle(): Promise<void> {
    return Promise.resolve()
  }

  #emit(event: AgentSessionEvent): void {
    for (const listener of this.#listeners)
      listener(event)
  }
}

function assistant(text: string): AssistantMessage {
  return {
    api: 'anthropic-messages',
    content: [{ type: 'text', text }],
    model: 'claude-sonnet-4-5',
    provider: 'anthropic',
    role: 'assistant',
    stopReason: 'stop',
    timestamp: Date.now(),
    usage: usage(10, 4),
  }
}

function entry(id: string, message: AssistantMessage | ToolResultMessage) {
  const timestamp = new Date().toISOString()
  return { createdAt: timestamp, id, message, parentId: null, timestamp, type: 'message' as const }
}

function usage(input: number, output: number): Usage {
  return {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.01, output: 0.02, total: 0.03 },
    input,
    output,
    totalTokens: input + output,
  }
}

function openTrackedDatabase(databasePath: string): DatabaseSync {
  const database = openBuddyDatabase({ databasePath })
  databases.push(database)
  return database
}

function offlineProviderConfig(baseUrl: string) {
  return {
    api: 'openai-completions',
    baseUrl,
    displayName: 'Offline integration provider',
    enabled: true,
    id: 'offline-provider',
    models: [{
      contextWindow: 16_384,
      id: 'offline-model',
      input: ['text', 'image'],
      maxTokens: 1_024,
      name: 'Offline model',
      reasoning: false,
    }],
  }
}

async function turnRequest(harness: RuntimeRpcHarness, input: {
  branchId?: string
  content: string
  conversationId?: string
  resourceIds?: readonly string[]
  requestId: string
}) {
  const initialContent = {
    ...createBuddyUserContent(input.content),
    panelResourceIds: [...(input.resourceIds ?? [])],
  }
  const opened = await harness.invoke('composerDrafts.open', {
    draftId: `draft-${input.requestId}`,
    initialContent,
    initialExecutionConfig: {
      approvalPolicy: 'policy',
      executionProfile: 'workspace_write',
    },
    initialModelSelection: {
      modelId: 'offline-model',
      providerId: 'offline-provider',
      reasoning: null,
      serviceTier: null,
    },
    scope: input.conversationId && input.branchId
      ? {
          branchId: input.branchId,
          conversationId: input.conversationId,
          kind: 'conversation_branch',
        }
      : { kind: 'global' },
  }) as {
    draftId: string
    revision: number
  }
  const draft = await harness.invoke('composerDrafts.save', {
    content: initialContent,
    draftId: opened.draftId,
    executionConfig: {
      approvalPolicy: 'policy',
      executionProfile: 'workspace_write',
    },
    expectedRevision: opened.revision,
    modelSelection: {
      modelId: 'offline-model',
      providerId: 'offline-provider',
      reasoning: null,
      serviceTier: null,
    },
  }) as {
    draftId: string
    revision: number
  }
  return {
    draftId: draft.draftId,
    expectedRevision: draft.revision,
    requestId: input.requestId,
  }
}

async function waitForTerminalRun(
  harness: RuntimeRpcHarness,
  runId: string,
): Promise<LocalTurnStart['run']> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = await harness.invoke('runs.get', { runId }) as LocalTurnStart['run']
    if (run.status !== 'queued' && run.status !== 'running')
      return run
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Run did not reach a terminal state: ${runId}`)
}

async function waitForAutomationOccurrence(
  harness: RuntimeRpcHarness,
  automationId: string,
): Promise<LocalAutomationOccurrencePage['items'][number]> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const page = await harness.invoke('automations.listOccurrences', {
      automationId,
      limit: 20,
    }) as LocalAutomationOccurrencePage
    const occurrence = page.items[0]
    if (
      occurrence?.runId
      && !['queued', 'running', 'awaiting_approval'].includes(occurrence.effectiveStatus)
    ) {
      return occurrence
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Automation occurrence did not reach a terminal state: ${automationId}`)
}

function readDataImageUrls(request: Record<string, unknown> | undefined): string[] {
  const messages = Array.isArray(request?.messages) ? request.messages : []
  return messages.flatMap((message) => {
    const content = readRecord(message)?.content
    if (!Array.isArray(content))
      return []
    return content.flatMap((item) => {
      const imageUrl = readRecord(readRecord(item)?.image_url)?.url
      return typeof imageUrl === 'string' && imageUrl.startsWith('data:image/')
        ? [imageUrl]
        : []
    })
  })
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

interface RuntimeRpcHarness {
  invoke: (method: string, params: unknown) => Promise<unknown>
  notifyRuntime: (method: string, params: unknown) => void
  notifications: Array<{ method: string, params: unknown }>
  rpc: BuddyServiceRpcServer
}

function createRuntimeRpcHarness(
  initialCredentials: Readonly<Record<string, Credential>> = {},
): RuntimeRpcHarness {
  const handlers = new Map<string, Parameters<BuddyServiceRpcServer['onRequest']>[1]>()
  const notificationListeners = new Set<(method: string, params: unknown) => void>()
  const credentials = new Map(Object.entries(initialCredentials).map(([providerId, credential]) =>
    [providerId, structuredClone(credential)],
  ))
  const secrets = new Map<string, unknown>()
  const notifications: Array<{ method: string, params: unknown }> = []
  const rpc = {
    close() {},
    notify(method: string, params: unknown) {
      notifications.push({ method, params })
    },
    onNotification(listener: (method: string, params: unknown) => void) {
      notificationListeners.add(listener)
      return () => notificationListeners.delete(listener)
    },
    onRequest(method: string, handler: Parameters<BuddyServiceRpcServer['onRequest']>[1]) {
      handlers.set(method, handler)
      return () => handlers.delete(method)
    },
    request(method: string, params: unknown) {
      const input = params as {
        credential?: Credential
        id?: string
        namespace?: string
        providerId?: string
        value?: unknown
      }
      if (method === 'host.runtimePreferences.get')
        return Promise.resolve({ cacheWarming: 'off' })
      if (method === 'host.credentials.list') {
        return Promise.resolve({
          ok: true,
          providers: [...credentials].map(([providerId, credential]) => ({
            providerId,
            type: credential.type,
          })),
        })
      }
      if (method === 'host.credentials.read') {
        return Promise.resolve({
          ok: true,
          value: structuredClone(credentials.get(input.providerId ?? '') ?? null),
        })
      }
      if (method === 'host.credentials.write' && input.providerId && input.credential) {
        credentials.set(input.providerId, structuredClone(input.credential))
        return Promise.resolve({ ok: true })
      }
      if (method === 'host.credentials.delete' && input.providerId) {
        credentials.delete(input.providerId)
        return Promise.resolve({ ok: true })
      }
      if (method === 'host.secrets.read' && input.namespace === 'connectors' && input.id) {
        return Promise.resolve({
          ok: true,
          value: structuredClone(secrets.get(input.id) ?? null),
        })
      }
      if (
        method === 'host.secrets.write'
        && input.namespace === 'connectors'
        && input.id
        && input.value
      ) {
        secrets.set(input.id, structuredClone(input.value))
        return Promise.resolve({ ok: true })
      }
      if (method === 'host.secrets.delete' && input.namespace === 'connectors' && input.id) {
        secrets.delete(input.id)
        return Promise.resolve({ ok: true })
      }
      return Promise.reject(new Error(`Unexpected host request: ${method}`))
    },
  } as unknown as BuddyServiceRpcServer
  return {
    async invoke(method, params) {
      const handler = handlers.get(method)
      if (!handler)
        throw new Error(`Runtime handler is unavailable: ${method}`)
      return handler(params)
    },
    notifyRuntime(method, params) {
      for (const listener of notificationListeners)
        listener(method, params)
    },
    notifications,
    rpc,
  }
}

function createRuntimeRpcStub(): BuddyServiceRpcServer {
  return createRuntimeRpcHarness().rpc
}

interface LocalModelProvider {
  baseUrl: string
  requests: Array<Record<string, unknown>>
}

async function startLocalModelProvider(): Promise<LocalModelProvider> {
  const requests: Array<Record<string, unknown>> = []
  const server = createServer((request, response) => {
    void handleLocalModelRequest(request, response, requests)
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests }
}

async function handleLocalModelRequest(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
  requests: Array<Record<string, unknown>>,
): Promise<void> {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end()
    return
  }
  const chunks: Buffer[] = []
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  requests.push(payload)
  const id = `chatcmpl-${requests.length}`
  const common = {
    created: 1_786_759_963,
    id,
    model: 'offline-model',
    object: 'chat.completion.chunk',
  }
  response.writeHead(200, {
    'cache-control': 'no-cache',
    'content-type': 'text/event-stream',
  })
  response.write(`data: ${JSON.stringify({
    ...common,
    choices: [{
      delta: { content: `offline reply ${requests.length}`, role: 'assistant' },
      finish_reason: null,
      index: 0,
    }],
  })}\n\n`)
  response.write(`data: ${JSON.stringify({
    ...common,
    choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
  })}\n\n`)
  response.write(`data: ${JSON.stringify({
    ...common,
    choices: [],
    usage: { completion_tokens: 4, prompt_tokens: 10, total_tokens: 14 },
  })}\n\n`)
  response.end('data: [DONE]\n\n')
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
}

function restoreEnvironment(snapshot: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(process.env)) {
    if (!(name in snapshot))
      delete process.env[name]
  }
  Object.assign(process.env, snapshot)
}

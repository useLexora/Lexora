import type { DatabaseSync } from 'node:sqlite'
import type { LocalBuddy } from '../../../shared/buddies/buddyApi'
import type { LocalTurnStart } from '../../../shared/conversation/chatApi'
import type { ExtensionShellDescriptor } from '../../../shared/extensions/extensionShell'
import type { BuddyServiceRpcServer } from '../rpc/BuddyServiceRpcServer'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { expect, vi } from 'vitest'
import { DEFAULT_BUDDY_SETTINGS } from '../../../shared/buddies/buddySettings'
import { createBuddyUserContent } from '../../../shared/conversation/buddyUserContent'
import { readCheckpoint } from '../agent/sessions/tree/BuddyTreeStore'
import { startBuddyService } from '../BuddyService'
import { createChangeSetRepository } from '../changes/changeSetRepository'
import { MutationCoordinator } from '../changes/MutationCoordinator'
import { createRunEventLog } from '../events/createRunEventLog'
import { openBuddyDatabase } from '../storage/database'
import { createRunRepository } from '../storage/runRepository'

export const roles = ['root', 'actor', 'npc-a', 'npc-b'] as const
export type Role = typeof roles[number]
interface Payload {
  model: string
  messages: { role: string, content?: unknown, tool_call_id?: string }[]
  tools?: { function: { name: string } }[]
}
export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}
type Reply = { text: string } | { toolCall: ToolCall }

export function tool(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, arguments: args }
}

export function deferred() {
  return Promise.withResolvers<void>()
}

export function hash(text: string) {
  return createHash('sha256').update(text).digest('hex')
}

function requestRole(payload: Payload): Role {
  const system = JSON.stringify(payload.messages.filter(message => message.role === 'system' || message.role === 'developer'))
  const identities = ['ROOT', 'ACTOR', 'NPC'].filter(role => system.includes(`MUTATION_ROLE_${role}`))
  if (identities.length !== 1)
    throw new Error(`Expected one private role marker, got ${identities.join(',')}`)
  if (identities[0] === 'ROOT')
    return 'root'
  if (identities[0] === 'ACTOR')
    return 'actor'
  const firstUser = JSON.stringify(payload.messages.find(message => message.role === 'user')?.content)
  const task = /MUTATION_TASK:(npc-a|npc-b)\b/.exec(firstUser ?? '')?.[1]
  if (task !== 'npc-a' && task !== 'npc-b')
    throw new Error('NPC initial user task has no unique identity')
  return task
}

function rpcHarness(shells: readonly ExtensionShellDescriptor[]) {
  const handlers = new Map<string, Parameters<BuddyServiceRpcServer['onRequest']>[1]>()
  const rpc = {
    close() {},
    notify() {},
    onNotification() { return () => {} },
    onRequest(method: string, handler: Parameters<BuddyServiceRpcServer['onRequest']>[1]) {
      handlers.set(method, handler)
      return () => handlers.delete(method)
    },
    async request(method: string) {
      switch (method) {
        case 'extensions.agent.list': return []
        case 'host.extensions.shells.list': return shells
        case 'host.images.preferences': return {}
        case 'host.networkPermissions.get': return { defaults: { access: 'ask', download: 'ask', upload: 'ask' }, rules: [] }
        case 'host.runtimePreferences.get': return { cacheWarming: 'off', codemode: false, modelRetryLimit: 0 }
        case 'host.credentials.list': return { ok: true, providers: [{ providerId: 'mutation-local', type: 'api_key' }] }
        case 'host.credentials.read': return { ok: true, value: { type: 'api_key', key: 'local-test-only' } }
        default: throw new Error(`Unexpected host RPC: ${method}`)
      }
    },
  } as unknown as BuddyServiceRpcServer
  return {
    rpc,
    async invoke(method: string, params: unknown): Promise<unknown> {
      const handler = handlers.get(method)
      if (!handler)
        throw new Error(`Missing Runtime RPC: ${method}`)
      return handler(params)
    },
  }
}

export async function createConcurrencyRuntime(options: {
  steps: (role: Role) => ToolCall[]
  readOnly?: boolean
  fullAccess?: boolean
  shells?: readonly ExtensionShellDescriptor[]
  prepare?: (database: DatabaseSync, buddyHome: string) => Promise<void>
}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'lexora-mutation-tree-')))
  const buddyHome = join(directory, 'buddy')
  const skills = join(directory, 'skills')
  await mkdir(skills)
  const database = openBuddyDatabase({ databasePath: join(buddyHome, 'buddy.sqlite3') })
  const eventLog = createRunEventLog({ conversationsDirectory: join(buddyHome, 'conversations'), database })
  const events: Awaited<ReturnType<typeof eventLog.read>> = []
  const subscription = eventLog.onDidCommit(event => events.push(event))
  const harness = rpcHarness(options.shells ?? [])
  const ready = deferred()
  const begin = deferred()
  const requests: { role: Role, payload: Payload }[] = []
  const errors: unknown[] = []
  const cursors = new Map<Role, number>()
  const modelGates: ReturnType<typeof deferred>[] = []
  const holds = new Map<string, Promise<void>>()
  let npcId = ''
  let actorId = ''
  let runtime: Awaited<ReturnType<typeof startBuddyService>> | undefined

  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions')
        throw new Error(`Unexpected local Provider request: ${request.method} ${request.url}`)
      const chunks: Buffer[] = []
      for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Payload
      const role = requestRole(payload)
      requests.push({ role, payload })
      const cursor = cursors.get(role) ?? 0
      cursors.set(role, cursor + 1)
      if (role === 'root' && cursor === 0) {
        ready.resolve()
        await begin.promise
      }
      const delegation = role === 'root'
        ? [
            tool('root-delegate-actor', 'lexora_agents', { operation: 'delegate', targetId: actorId, text: 'MUTATION_TASK:actor' }),
            tool('root-delegate-npc', 'lexora_agents', { operation: 'delegate', targetId: npcId, text: 'MUTATION_TASK:npc-a' }),
          ]
        : role === 'actor'
          ? [tool('actor-delegate-npc', 'lexora_agents', { operation: 'delegate', targetId: npcId, text: 'MUTATION_TASK:npc-b' })]
          : []
      const call = [...delegation, ...options.steps(role)][cursor]
      if (call)
        await holds.get(call.id)
      const reply: Reply = call ? { toolCall: call } : { text: `MUTATION_DONE:${role}` }
      const common = { created: 1_786_759_963, id: `completion-${requests.length}`, model: payload.model, object: 'chat.completion.chunk' }
      response.writeHead(200, { 'cache-control': 'no-cache', 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({
        ...common,
        choices: [{
          delta: { role: 'assistant', ...('text' in reply
            ? { content: reply.text }
            : { tool_calls: [{ index: 0, id: reply.toolCall.id, type: 'function', function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.arguments) } }] }) },
          finish_reason: null,
          index: 0,
        }],
      })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ delta: {}, finish_reason: call ? 'tool_calls' : 'stop', index: 0 }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...common, choices: [], usage: { completion_tokens: 4, prompt_tokens: 10, total_tokens: 14 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    })().catch((error) => {
      errors.push(error)
      response.writeHead(500).end('Local Provider scenario failed')
    })
  })

  async function dispose() {
    begin.resolve()
    for (const gate of modelGates)
      gate.resolve()
    try {
      await runtime?.dispose()
    }
    finally {
      subscription.dispose()
      await eventLog.close()
      server.closeAllConnections()
      if (server.listening)
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      database.close()
      await rm(directory, { force: true, recursive: true })
    }
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('Local Provider did not bind TCP')
    await options.prepare?.(database, buddyHome)
    runtime = await startBuddyService({ buddyHome, database, eventLog, rpc: harness.rpc, builtinSkillsDirectories: [skills] })
    await harness.invoke('providers.upsertCustom', {
      api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      displayName: 'Local mutation scenario',
      enabled: true,
      id: 'mutation-local',
      models: [{ contextWindow: 131072, id: 'mutation-model', input: ['text'], maxTokens: 4096, name: 'Local mutation model', reasoning: false }],
    })
    const npc = await harness.invoke('buddies.create', { kind: 'npc', name: 'Repeated mutation worker' }) as LocalBuddy
    const actor = await harness.invoke('buddies.create', { kind: 'actor', name: 'Mutation actor' }) as LocalBuddy
    const root = await harness.invoke('buddies.get', { buddyId: 'default' }) as LocalBuddy
    npcId = npc.id
    actorId = actor.id
    const shellTool = options.shells?.length ? ['builtin', 'shell', 'lexora_shell'] : ['builtin', 'core', process.platform === 'win32' ? 'powershell' : 'bash']
    for (const [buddy, role] of [[npc, 'NPC'], [actor, 'ACTOR'], [root, 'ROOT']] as const) {
      await harness.invoke('buddies.update', {
        buddyId: buddy.id,
        expectedRevision: buddy.revision,
        settings: {
          ...DEFAULT_BUDDY_SETTINGS,
          instructions: `MUTATION_ROLE_${role}`,
          model: role === 'ACTOR' ? { modelId: 'mutation-model', providerId: 'mutation-local', reasoning: null, serviceTier: null } : null,
          skills: { mode: 'none' },
          tools: { mode: 'selected', ids: [...['read', 'write', 'edit'].map(name => JSON.stringify(['builtin', 'core', name])), ...options.fullAccess ? [JSON.stringify(shellTool)] : []] },
          limits: { fileAccess: options.readOnly && role === 'ROOT' ? 'read_only' : 'inherit' },
          npcIds: role === 'NPC' ? [] : [npcId],
        },
      })
    }
    const content = createBuddyUserContent('MUTATION_TASK:root')
    const executionConfig = { approvalPolicy: 'policy', executionProfile: options.fullAccess ? 'full_access' : 'workspace_write' }
    const modelSelection = { modelId: 'mutation-model', providerId: 'mutation-local', reasoning: null, serviceTier: null }
    const opened = await harness.invoke('composerDrafts.open', {
      draftId: 'mutation-draft',
      initialContent: content,
      initialExecutionConfig: executionConfig,
      initialModelSelection: modelSelection,
      scope: { kind: 'global' },
    }) as { draftId: string, revision: number }
    const saved = await harness.invoke('composerDrafts.save', {
      content,
      draftId: opened.draftId,
      executionConfig,
      expectedRevision: opened.revision,
      modelSelection,
    }) as { draftId: string, revision: number }
    const turn = await harness.invoke('chat.startTurn', {
      draftId: saved.draftId,
      expectedRevision: saved.revision,
      requestId: 'mutation-turn',
    }) as LocalTurnStart
    await expect.poll(() => requests.some(request => request.role === 'root'), { timeout: 15000 }).toBe(true)
    await ready.promise
    await harness.invoke('conversations.addMember', { conversationId: turn.conversationId, buddyId: actorId })
    const workspace = join(buddyHome, 'conversations', turn.conversationId, 'workspace')
    const runs = createRunRepository(database)
    return {
      directory,
      buddyHome,
      database,
      eventLog,
      events,
      requests,
      errors,
      workspace,
      turn,
      runs,
      npcId,
      actorId,
      invoke: harness.invoke,
      start: () => begin.resolve(),
      holdReply(toolCallId: string) {
        const gate = deferred()
        modelGates.push(gate)
        holds.set(toolCallId, gate.promise)
        return gate
      },
      async complete() {
        await expect.poll(() => runs.findById(turn.runId)?.status, { timeout: 25000 }).toBe('completed')
        expect(errors).toEqual([])
        expect(events.filter(event => event.type === 'approval.requested')).toEqual([])
      },
      dispose,
    }
  }
  catch (error) {
    await dispose()
    throw error
  }
}

export type ConcurrencyRuntime = Awaited<ReturnType<typeof createConcurrencyRuntime>>

// Only delay delivery of a real lease; admission, native locking and cancellation stay real.
export function mutationTiming() {
  const original = MutationCoordinator.prototype.acquire
  type Admission = Parameters<MutationCoordinator['acquire']>[0]
  const gates: { match: (input: Admission) => boolean, release: ReturnType<typeof deferred>, admissions: { input: Admission, coordinator: MutationCoordinator }[] }[] = []
  const spy = vi.spyOn(MutationCoordinator.prototype, 'acquire').mockImplementation(async function (this: MutationCoordinator, input) {
    const gate = gates.find(gate => gate.match(input))
    const acquiring = original.call(this, input)
    gate?.admissions.push({ input, coordinator: this })
    const lease = await acquiring
    if (gate)
      await gate.release.promise
    return lease
  })
  return {
    gate(match: (input: Admission) => boolean) {
      const gate = { match, release: deferred(), admissions: [] as { input: Admission, coordinator: MutationCoordinator }[] }
      gates.push(gate)
      return {
        release: () => gate.release.resolve(),
        admissions: gate.admissions,
        async waitFor(active: number, pending: number) {
          await expect.poll(() => {
            const states = [...new Map(gate.admissions.map(({ input, coordinator }) => [input.runId, coordinator.getRunState(input.runId)])).values()]
            return {
              admissions: gate.admissions.length,
              active: states.reduce((sum, state) => sum + state.active, 0),
              pending: states.reduce((sum, state) => sum + state.pending, 0),
            }
          }, { timeout: 15000 }).toEqual({ admissions: active + pending, active, pending })
        },
      }
    },
    dispose() {
      for (const gate of gates)
        gate.release.resolve()
      spy.mockRestore()
    },
  }
}

export function treeByRole(f: ConcurrencyRuntime) {
  const tree = f.runs.listTree(f.turn.runId)
  expect(tree).toHaveLength(4)
  const root = tree.find(run => run.id === f.turn.runId)!
  const actor = tree.find(run => run.executionKind === 'actor_child')!
  const npcA = tree.find(run => run.executionKind === 'npc_child' && run.parentRunId === root.id)!
  const npcB = tree.find(run => run.executionKind === 'npc_child' && run.parentRunId === actor.id)!
  expect(actor).toMatchObject({ parentRunId: root.id, buddyId: f.actorId })
  expect([npcA.buddyId, npcB.buddyId]).toEqual([f.npcId, f.npcId])
  expect(new Set(tree.map(run => run.threadId)).size).toBe(4)
  expect(new Set(tree.map(run => run.piSessionFile)).size).toBe(4)
  for (const run of tree) {
    expect(run.rootRunId).toBe(root.id)
    expect(run.actorSnapshot?.settings.npcConcurrency).toEqual({ mode: 'limited', limit: 5 })
  }
  return { root, actor, 'npc-a': npcA, 'npc-b': npcB }
}

export async function assertDurableTree(f: ConcurrencyRuntime, cancelled: Role[] = []) {
  const tree = treeByRole(f)
  for (const role of roles) {
    const run = tree[role]
    const status = cancelled.includes(role) ? 'cancelled' : 'completed'
    expect(run.status).toBe(status)
    const persisted = await f.eventLog.read(run.id)
    expect(persisted.filter(event => event.type === `run.${status}`)).toHaveLength(1)
    const journal = SessionManager.open(run.piSessionFile!)
    expect(JSON.stringify(journal.getEntries())).toContain(`MUTATION_TASK:${role}`)
    if (status === 'completed') {
      const after = journal.getEntries().filter(entry => readCheckpoint(entry)?.runId === run.id && readCheckpoint(entry)?.position === 'after')
      expect(after).toHaveLength(1)
      expect(JSON.stringify(journal.getBranch(after[0]!.id))).toContain(`MUTATION_DONE:${role}`)
    }
  }
  expect(f.database.prepare('SELECT COUNT(*) AS count FROM run_mutation_leases WHERE run_id IN (?, ?, ?, ?) AND status <> \'released\'').get(...Object.values(tree).map(run => run.id))?.count).toBe(0)
  expect(f.database.prepare('SELECT COUNT(*) AS count FROM run_change_invocations WHERE status = \'pending\' OR (tool_name IN (\'write\', \'edit\') AND status <> \'completed\')').get()?.count).toBe(0)
  return tree
}

export function captures(f: ConcurrencyRuntime) {
  const repository = createChangeSetRepository(f.database)
  const sets = repository.listSetsForRunTrees([f.turn.runId])
  for (const set of sets)
    expect(set).toMatchObject({ status: 'completed', coverage: 'complete' })
  return sets.flatMap(set => repository.listCaptures(set.id)).sort((a, b) => a.invocation!.sequence - b.invocation!.sequence)
}

export async function assertCaptureChain(f: ConcurrencyRuntime, path: string, before: string, after: string, count: number) {
  const chain = captures(f).filter(capture => capture.canonicalPath === path)
  expect(chain).toHaveLength(count)
  expect(chain[0]!.before.hash).toBe(hash(before))
  expect(chain.at(-1)!.after?.hash).toBe(hash(after))
  for (const [index, capture] of chain.entries()) {
    expect(capture.status).toBe('completed')
    expect(capture.invocation).toMatchObject({ status: 'completed', toolCallId: capture.toolCallId })
    expect(capture.actorId).toBe(f.runs.findById(capture.invocation!.runId)?.buddyId)
    const lease = f.database.prepare('SELECT run_id, segment_id, status FROM run_mutation_leases WHERE invocation_id = ?').get(capture.invocationId!)
    expect(lease).toMatchObject({ run_id: capture.invocation!.runId, segment_id: capture.invocation!.segmentId, status: 'released' })
    if (index)
      expect(capture.before.hash).toBe(chain[index - 1]!.after?.hash)
    for (const state of [capture.before, capture.after!]) {
      expect(state.kind).toBe('text')
      expect(hash(await readFile(state.snapshotPath!, 'utf8'))).toBe(state.hash)
    }
  }
  return chain
}

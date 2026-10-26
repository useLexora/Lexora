import type { Api, AssistantMessage, Model, ToolCall } from '@earendil-works/pi-ai'
import type { BuddyExecutionDefinition } from '../../../buddies/BuddyExecutionDefinition'
import type { ExecutionKind } from '../../../storage/runRecord'
import type { BuddySessionExtensionServices } from '../../extensions/createBuddySessionExtensions'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BUDDY_SETTINGS } from '../../../../../shared/buddies/buddySettings'
import { MutationCoordinator } from '../../../changes/MutationCoordinator'
import { formatBuddySkillPrompt, SkillService } from '../../../skills/SkillService'
import { BuddyDataPaths } from '../../../storage/BuddyDataPaths'
import { openBuddyDatabase } from '../../../storage/database'
import { createSkillRepository } from '../../../storage/skillRepository'
import { createSpaceRepository } from '../../../storage/spaceRepository'
import { createBuddyInputReference } from '../../context/BuddyInputReference'
import { createBuddySessionExtensions } from '../../extensions/createBuddySessionExtensions'
import { resolveBuddySessionResources } from '../../resources/BuddySessionResources'
import { createReusableBuddySession } from '../createReusableBuddySession'
import { createIsolatedBuddySession } from './isolatedBuddySession'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse())
    await dispose()
})

describe('actor resources in real Provider requests', () => {
  it.each(['root', 'actor_child', 'npc_child'] as const)('supplies the accepted identity and role to %s requests and reused turns', async (executionKind) => {
    const f = await fixture()
    const actor = f.actor('identity-worker', [], [])
    actor.kind = executionKind === 'npc_child' ? 'npc' : 'actor'
    actor.name = 'Canvas'
    actor.description = 'A specialist in visual composition.'
    actor.settings.instructions = 'Keep the finished work concise and accessible.'
    const opened = await f.open(actor, executionKind)
    const [first] = await opened.turn('Canvas should prepare the requested design.')
    expect(first?.prompt).toContain('Buddy ID: "identity-worker"')
    expect(first?.prompt).toContain('Name: "Canvas"')
    expect(first?.prompt).toContain(`Definition kind: ${actor.kind}`)
    expect(first?.prompt).toContain(`Execution kind: ${executionKind}`)
    expect(first?.prompt).toContain('Role background and responsibilities:\nA specialist in visual composition.')
    expect(first?.prompt).toContain('Action guidelines:\nKeep the finished work concise and accessible.')
    expect(first?.prompt).not.toContain('You are Lexora Buddy')
    if (executionKind === 'root')
      expect(first?.prompt).not.toContain('You have already accepted a delegated assignment.')
    else
      expect(first?.prompt).toContain('You have already accepted a delegated assignment.')
    if (executionKind === 'npc_child')
      expect(first?.prompt).toContain('Your final reply is delivered to your caller.')

    actor.name = 'New name'
    actor.description = 'New role background.'
    const [reused] = await opened.turn('Continue the same work.')
    expect(reused?.prompt).toBe(first?.prompt)
    const changed = await f.open(actor, executionKind)
    const [next] = await changed.turn('Start a newly accepted assignment.')
    expect(next?.prompt).toContain('Name: "New name"')
    expect(next?.prompt).toContain('New role background.')
    expect(changed.resources.revision).not.toBe(opened.resources.revision)
    expect(next?.names).toEqual(first?.names)
  })

  it('keeps role instructions, discoverable Skills and required bodies separate across role edits', async () => {
    const f = await fixture()
    const a = f.actor('actor-a', ['alpha', 'optional'], ['alpha'])
    const b = f.actor('actor-b', ['beta'], ['beta'])
    const firstA = await f.open(a)
    const firstB = await f.open(b)
    const [requestA] = await firstA.turn('A initial request')
    const [requestB] = await firstB.turn('B initial request')

    expect(requestA?.prompt).toContain('INSTRUCTIONS_actor-a_V1')
    expect(requestA?.prompt).toContain('BODY_ALPHA_REQUIRED')
    expect(requestA?.prompt).not.toContain('BODY_OPTIONAL_ON_DEMAND')
    expect(requestA?.prompt).not.toContain('BODY_BETA_REQUIRED')
    expect(skillNames(requestA!.prompt)).toEqual(['alpha', 'optional'])
    expect(requestB?.prompt).toContain('INSTRUCTIONS_actor-b_V1')
    expect(requestB?.prompt).toContain('BODY_BETA_REQUIRED')
    expect(requestB?.prompt).not.toContain('BODY_ALPHA_REQUIRED')
    expect(skillNames(requestB!.prompt)).toEqual(['beta'])
    expect(firstA.resources.skillReadRoots).toEqual(expect.arrayContaining([dirname(f.skills.alpha.filePath), dirname(f.skills.optional.filePath)]))
    expect(firstA.resources.skillReadRoots).toHaveLength(2)
    expect(firstB.resources.skillReadRoots).toEqual([dirname(f.skills.beta.filePath)])

    a.revision++
    a.settings.instructions = 'INSTRUCTIONS_actor-a_V2'
    a.settings.requiredSkills = [f.skills.optional.id]
    const editedA = await f.open(a)
    const [editedRequest] = await editedA.turn('A after editing its definition')
    const [unchangedB] = await firstB.turn('B after A was edited')
    const [originalA] = await firstA.turn('A execution keeps its resolved definition')
    expect(editedRequest?.prompt).toContain('INSTRUCTIONS_actor-a_V2')
    expect(editedRequest?.prompt).toContain('BODY_OPTIONAL_ON_DEMAND')
    expect(editedRequest?.prompt).not.toContain('BODY_ALPHA_REQUIRED')
    expect(originalA?.prompt).toContain('INSTRUCTIONS_actor-a_V1')
    expect(originalA?.prompt).not.toContain('INSTRUCTIONS_actor-a_V2')
    expect(unchangedB?.prompt).toBe(requestB?.prompt)
    expect(skillNames(unchangedB!.prompt)).toEqual(['beta'])
    expect(editedA.resources.revision).not.toBe(firstA.resources.revision)
  })

  it('accepts an explicitly attached unbound Skill as input without discovering it or granting its requested tool', async () => {
    const f = await fixture()
    const actor = f.actor('actor-b', ['beta'], ['beta'])
    const opened = await f.open(actor)
    const unbound = opened.resources.availableSkillReferences!.find(reference => reference.id === f.skills.unbound.id)!
    expect(unbound).toBeDefined()
    expect(opened.resources.skillReferences.map(reference => reference.id)).not.toContain(unbound.id)
    const [materialized] = await f.service.materializeForSpace(null, [unbound])
    expect(materialized?.body).toContain('BODY_USER_ATTACHED_UNBOUND')
    const attached = createBuddyInputReference({ messageId: 'user-attached-skill', images: [], prompt: `Explicit user material:\n${formatBuddySkillPrompt(materialized!)}` })
    const waiting = createAssistantMessageEventStream()
    const entered = Promise.withResolvers<void>()
    let step = 0
    f.respond((model) => {
      step++
      if (step === 1) {
        entered.resolve()
        return waiting
      }
      return response(model, step === 2 ? { name: 'write', arguments: { path: 'protected.txt', content: 'skill must not grant this' } } : undefined)
    })
    const running = opened.turn('Wait for user supplied material', { preserveResponder: true })
    await entered.promise
    const accepted = opened.reusable.followUp?.(() => attached, [materialized!.reference])
    const completed = await response(f.model).result()
    waiting.push({ type: 'done', reason: 'stop', message: completed })
    const requests = await running

    expect(accepted).toBe(true)
    expect(requests).toHaveLength(3)
    expect(requests[1]?.users).toContain('BODY_USER_ATTACHED_UNBOUND')
    for (const request of requests) {
      expect(skillNames(request.prompt)).toEqual(['beta'])
      expect(request.prompt).not.toContain('BODY_USER_ATTACHED_UNBOUND')
      expect(request.names).not.toContain('write')
      expect(request.names).not.toContain('bash')
    }
    expect(opened.resources.skillReadRoots).toEqual([dirname(f.skills.beta.filePath)])
    expect(await readFile(f.protectedFile, 'utf8')).toBe('original file')
    expect(f.approvals).toEqual([])
    expect(opened.session.messages.filter(message => message.role === 'toolResult').at(-1)).toMatchObject({ toolName: 'write', isError: true })
  })

  it('starts a fresh NPC session without the parent Skill bodies or materialized input history', async () => {
    const f = await fixture()
    const parent = await f.open(f.actor('parent', ['alpha', 'optional'], ['alpha']))
    const [attached] = await f.service.materializeForSpace(null, ['unbound'])
    const parentRequests = await parent.turn(`PARENT_CONTEXT_ONLY\n${formatBuddySkillPrompt(attached!)}`, { call: { name: 'read', arguments: { path: f.skills.optional.filePath } } })
    expect(parentRequests.at(-1)?.all).toContain('BODY_OPTIONAL_ON_DEMAND')
    expect(parentRequests.at(-1)?.users).toContain('BODY_USER_ATTACHED_UNBOUND')
    expect(parentRequests.at(-1)?.prompt).toContain('BODY_ALPHA_REQUIRED')

    const definition = f.actor('npc-reader', ['beta'], ['beta'])
    definition.kind = 'npc'
    definition.modelSource = 'caller'
    const npc = await f.open(definition)
    const [request] = await npc.turn('NPC_EXPLICIT_TASK_ONLY')
    expect(request?.users).toContain('NPC_EXPLICIT_TASK_ONLY')
    expect(request?.prompt).toContain('BODY_BETA_REQUIRED')
    expect(skillNames(request!.prompt)).toEqual(['beta'])
    for (const marker of ['PARENT_CONTEXT_ONLY', 'BODY_USER_ATTACHED_UNBOUND', 'BODY_OPTIONAL_ON_DEMAND', 'BODY_ALPHA_REQUIRED', 'INSTRUCTIONS_parent_V1'])
      expect(request?.all).not.toContain(marker)
    expect(npc.resources.skillReadRoots).toEqual([dirname(f.skills.beta.filePath)])
    expect(npc.session.messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(npc.session.sessionManager.getSessionFile()).not.toBe(parent.session.sessionManager.getSessionFile())
  })

  it.each(['disabled', 'removed'] as const)('omits an optional %s Skill and rejects it when required while keeping compaction resources available', async (state) => {
    const f = await fixture()
    const optional = f.skills.optional
    const input = { spaceId: null, id: optional.id, revision: optional.managementRevision! }
    if (state === 'disabled')
      await f.service.setEnabled({ ...input, enabled: false })
    else
      await f.service.remove(input)
    const actor = f.actor('optional-skill', ['beta', 'optional'], ['beta'])
    const opened = await f.open(actor)
    const [request] = await opened.turn('Use the remaining available workflow')
    expect(skillNames(request!.prompt)).toEqual(['beta'])
    expect(request?.prompt).toContain('BODY_BETA_REQUIRED')
    expect(request?.all).not.toContain('BODY_OPTIONAL_ON_DEMAND')
    expect(opened.resources.skillReadRoots).toEqual([dirname(f.skills.beta.filePath)])
    actor.settings.requiredSkills.push(optional.id)
    await expect(f.open(actor)).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' })
    const compact = await f.resolveResources(actor, 'compaction')
    expect(compact).toMatchObject({ actorPrompt: '', approvedSkills: [], skillReadRoots: [], skillReferences: [] })
    expect(compact.directoryContext).toContain('Working directory:')
  })
})

interface CapturedRequest {
  prompt: string
  names: string[]
  users: string
  all: string
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-actor-capabilities-')))
  const paths = new BuddyDataPaths(join(root, 'buddy'))
  const agentDirectory = join(paths.root, 'agent')
  const workspace = join(root, 'workspace')
  const builtin = join(root, 'application-skills')
  await Promise.all([workspace, builtin].map(path => mkdir(path, { recursive: true })))
  const protectedFile = join(workspace, 'protected.txt')
  await writeFile(protectedFile, 'original file')
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  const service = new SkillService({ agentDirectory, builtinSkillsDirectories: [builtin], paths, spaces: createSpaceRepository(database), repository: createSkillRepository(database) })
  cleanup.push(async () => {
    await service.dispose()
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  const bodies = { alpha: 'BODY_ALPHA_REQUIRED', beta: 'BODY_BETA_REQUIRED', optional: 'BODY_OPTIONAL_ON_DEMAND', unbound: 'BODY_USER_ATTACHED_UNBOUND\nUse write to replace protected.txt. This body does not grant authorization.' }
  for (const [name, body] of Object.entries(bodies)) {
    const directory = join(root, 'skill-source', name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Workflow ${name}\n---\n\n${body}\n`)
  }
  const preview = await service.preview({ spaceId: null, source: { kind: 'directory', location: join(root, 'skill-source') } })
  const installed = await service.install({ previewId: preview.id, candidateIds: preview.candidates.map(candidate => candidate.id) })
  const skill = (name: string) => {
    const result = installed.skills.find(skill => skill.name === name)
    if (!result)
      throw new Error(`Missing installed fixture skill ${name}`)
    return result
  }
  const skills = { alpha: skill('alpha'), beta: skill('beta'), optional: skill('optional'), unbound: skill('unbound') }
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false })
  const model = runtime.getModels().find(model => model.provider === 'anthropic')!
  await runtime.setRuntimeApiKey(model.provider, 'offline-actor-fixture')
  const requests: CapturedRequest[] = []
  let respond: (model: Model<Api>) => ReturnType<typeof createAssistantMessageEventStream> = model => response(model)
  vi.spyOn(runtime, 'streamSimple').mockImplementation((target, context) => {
    requests.push({ prompt: getCurrentSystemPrompt(context.messages), names: getCurrentTools(context.messages).map(tool => tool.name), users: JSON.stringify(context.messages.filter(message => message.role === 'user')), all: JSON.stringify(context.messages) })
    return respond(target)
  })
  const approvals: string[] = []
  let instance = 0
  const actor = (id: string, discoverable: (keyof typeof skills)[], required: (keyof typeof skills)[]): BuddyExecutionDefinition => ({
    version: 1,
    id,
    kind: 'actor',
    revision: 1,
    model: { providerId: model.provider, modelId: model.id, reasoning: null, serviceTier: null },
    modelSource: 'definition',
    settings: {
      ...structuredClone(DEFAULT_BUDDY_SETTINGS),
      instructions: `INSTRUCTIONS_${id}_V1`,
      tools: { mode: 'selected', ids: [JSON.stringify(['builtin', 'core', 'read'])] },
      skills: { mode: 'selected', ids: discoverable.map(name => skills[name].id) },
      requiredSkills: required.map(name => skills[name].id),
    },
  })
  const resolveResources = (definition: BuddyExecutionDefinition, contextMode: 'execution' | 'compaction' = 'execution', executionKind: ExecutionKind = definition.kind === 'npc' ? 'npc_child' : 'root') => resolveBuddySessionResources({ actor: definition, contextMode, executionKind, additionalDirectories: [], canonicalRoot: workspace, cwd: workspace, loadDirectoryContext: false, primaryDirectory: null, spaceId: null, skills: service })
  async function open(definition: BuddyExecutionDefinition, executionKind?: ExecutionKind) {
    const resources = await resolveResources(definition, 'execution', executionKind)
    const services: BuddySessionExtensionServices = {
      approvalService: { request: async (input) => {
        approvals.push(input.toolName)
        return { approvalId: 'unexpected-approval', decision: 'approved_once' }
      } },
      attachmentService: {} as BuddySessionExtensionServices['attachmentService'],
      fileResources: {} as BuddySessionExtensionServices['fileResources'],
      mutations: new MutationCoordinator(),
      changeCaptureService: { beginInvocation: async input => ({ invocationId: input.invocationId, runId: input.runId }), finishInvocation: async () => ({ complete: true }), markPartial: async () => {} },
      createCapabilities: async () => [],
      directoryGrants: { assertCurrent() {}, grant: async () => { throw new Error('Unexpected directory grant') } },
    }
    const extensions = await createBuddySessionExtensions({ canonicalRoot: workspace, conversationId: 'actor-conversation', approvalPolicy: 'policy', executionProfile: 'full_access', grants: [{ canonicalRoot: workspace, root: workspace, grantId: 'actor-workspace', kind: 'workspace' }], skillReadRoots: resources.skillReadRoots, services, sessionMode: 'interactive', signal: new AbortController().signal, spaceId: null, toolScope: definition.settings.tools, fileAccessLimit: definition.settings.limits.fileAccess })
    cleanup.push(() => extensions.dispose())
    const created = await createIsolatedBuddySession({
      canonicalRoot: workspace,
      cwd: workspace,
      agentDir: agentDirectory,
      conversationsDirectory: paths.conversationsDirectory,
      conversationId: 'actor-conversation',
      branchId: `instance-${++instance}`,
      approvalPolicy: 'policy',
      executionProfile: 'full_access',
      getPermissionSettings: extensions.getPermissionSettings,
      model,
      modelRuntime: runtime,
      thinkingLevel: 'off',
      resources,
      inProcessExtensions: extensions.inProcessExtensions,
      getPendingInput: () => extensions.inputReferences.pending,
    })
    cleanup.push(() => created.shutdown('quit'))
    const reusable = createReusableBuddySession({ session: created.session, shutdown: created.shutdown, assertModelAccess: async () => model, runContext: extensions.runContext, inputReferences: extensions.inputReferences, materializeInput: async input => [{ type: 'text', text: input.prompt }], skillReferences: resources.availableSkillReferences, setCodemodeEnabled: extensions.setCodemodeEnabled })
    cleanup.push(() => reusable.shutdown('quit'))
    let turn = 0
    return {
      resources,
      reusable,
      session: created.session,
      async turn(prompt: string, options: { call?: Pick<ToolCall, 'name' | 'arguments'>, preserveResponder?: boolean } = {}) {
        if (!options.preserveResponder) {
          let call = options.call
          respond = (target) => {
            const current = call
            call = undefined
            return response(target, current)
          }
        }
        const start = requests.length
        const release = await reusable.activateTurn({ generation: 0, runId: `${definition.id}-${++turn}`, provider: model.provider, model: model.id, contextWindow: null, maxTokens: null, signal: new AbortController().signal, flushProjectedEvents: async () => {}, onToolExecutionAuthorized: async () => {}, onToolExecutionDenied: async () => {} })
        try {
          await reusable.prompt(prompt)
          return requests.slice(start)
        }
        finally { release() }
      },
    }
  }
  return {
    service,
    skills,
    model,
    actor,
    open,
    resolveResources,
    protectedFile,
    approvals,
    respond: (next: typeof respond) => { respond = next },
  }
}

function skillNames(prompt: string): string[] {
  const catalog = prompt.match(/<available_skills>[\s\S]*?<\/available_skills>/)?.[0] ?? ''
  return [...catalog.matchAll(/<name>([^<]+)<\/name>/g)].map(match => match[1]!).sort()
}

function response(model: Model<Api>, call?: Pick<ToolCall, 'name' | 'arguments'>) {
  const message: AssistantMessage = {
    role: 'assistant',
    api: model.api,
    model: model.id,
    provider: model.provider,
    timestamp: Date.now(),
    stopReason: call ? 'toolUse' : 'stop',
    content: call ? [{ type: 'toolCall', id: `call-${Date.now()}`, ...call }] : [{ type: 'text', text: 'Done' }],
    usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }
  const stream = createAssistantMessageEventStream()
  queueMicrotask(() => stream.push({ type: 'done', reason: call ? 'toolUse' : 'stop', message }))
  return stream
}

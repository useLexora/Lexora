import type { AssistantMessage, AuthType } from '@earendil-works/pi-ai'
import type { ExecutionPermissionSettings } from '../../../permissions/permissionContract'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessageEventStream, getCurrentSystemPrompt, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createImageGenerationCapability } from '../../../images/imageGenerationExtension'
import { OpenAiImageGenerationService } from '../../../images/OpenAiImageGenerationService'
import { WINDOWS_SANDBOX_FILESYSTEM_LIMITS } from '../../../sandbox/shellExecution'
import { SkillService } from '../../../skills/SkillService'
import { BuddyDataPaths } from '../../../storage/BuddyDataPaths'
import { openBuddyDatabase } from '../../../storage/database'
import { createSkillRepository } from '../../../storage/skillRepository'
import { createSpaceRepository } from '../../../storage/spaceRepository'
import { createEstimatedContextUsage } from '../../context/contextUsageBreakdown'
import { createToolDiscoveryCapability } from '../../extensions/discovery/toolDiscoveryExtension'
import { createPermissionPrompt } from '../../resources/createBuddyResourceLoader'
import { BUDDY_MANUAL_APPROVAL_PROMPT, createBuddySystemPrompt } from '../../resources/createBuddySystemPrompt'

import { createBuddySession as createPreparedBuddySession } from '../createBuddySession'
import {
  createIsolatedBuddyContextSnapshot as createBuddyContextSnapshot,
  createIsolatedBuddySession as createBuddySession,
} from './isolatedBuddySession'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('permission prompts', () => {
  it.each(['linux', 'win32'] as const)('keeps full-access network approval under a role file limit on %s', (platform) => {
    const settings: ExecutionPermissionSettings = { executionProfile: 'full_access', approvalPolicy: 'manual', fileAccessLimit: 'read_only' }
    const prompt = createPermissionPrompt(settings, platform)
    expect(prompt).toContain('inherits the full_access base profile')
    expect(prompt).toContain('Writing and deleting local files and host execution are prohibited')
    expect(prompt).toContain('read-only OS sandbox policy')
    expect(prompt).toContain('Network access and approval policy inherit the base mode')
    expect(prompt).toContain('including network requests, are automatically approved')
    expect(prompt).toContain('Explicit tool-scope limits, managed-network domain denials and execution-target validation still apply')
    expect(prompt).not.toContain('Commands run on the host without shell sandbox isolation')
    expect(prompt).not.toContain('This conversation uses the local read-only execution profile')
    expect(prompt).not.toContain('local read-only mode does not auto-approve them')
    expect(prompt).not.toContain(BUDDY_MANUAL_APPROVAL_PROMPT)
    expect(prompt.includes(WINDOWS_SANDBOX_FILESYSTEM_LIMITS)).toBe(platform === 'win32')
    expect(createBuddySystemPrompt({ ...settings, platform })).toContain(prompt)
  })

  it.each(['policy', 'manual'] as const)('keeps workspace approval %s without promising local writes under a role file limit', (approvalPolicy) => {
    const settings: ExecutionPermissionSettings = { executionProfile: 'workspace_write', approvalPolicy, fileAccessLimit: 'read_only' }
    const prompt = createPermissionPrompt(settings, 'linux')
    expect(prompt).toContain('inherits the workspace_write base profile')
    expect(prompt).toContain('Writing and deleting local files and host execution are prohibited')
    expect(prompt).toContain('sensitive reads still require approval')
    expect(prompt).toContain('Network requests and external tools retain the base domain rules and approval policy')
    expect(prompt).not.toContain('Modify only authorized directories')
    expect(prompt).not.toContain('Use lexora_authorize_directory with read or write')
    expect(prompt).not.toContain('use lexora_host_shell')
    expect(prompt.includes(BUDDY_MANUAL_APPROVAL_PROMPT)).toBe(approvalPolicy === 'manual')
    expect(createBuddySystemPrompt({ ...settings, platform: 'linux' })).toContain(prompt)
  })

  it.each(['read_only', 'workspace_write', 'full_access'] as const)('preserves the ordinary %s profile with no role restriction', (executionProfile) => {
    const settings: ExecutionPermissionSettings = { executionProfile, approvalPolicy: 'policy' }
    const prompt = createPermissionPrompt(settings, 'win32')
    expect(createPermissionPrompt({ ...settings, fileAccessLimit: 'inherit' }, 'win32')).toBe(prompt)
    expect(prompt).not.toContain('role or inherited local file read-only limit')
    if (executionProfile === 'read_only') {
      expect(createPermissionPrompt({ ...settings, fileAccessLimit: 'read_only' }, 'win32')).toBe(prompt)
      expect(prompt).toContain('local read-only mode does not auto-approve them')
    }
    else if (executionProfile === 'full_access') {
      expect(prompt).toContain('Commands run on the host without shell sandbox isolation')
      expect(prompt).not.toContain(WINDOWS_SANDBOX_FILESYSTEM_LIMITS)
    }
    else {
      expect(prompt).toContain('Modify only authorized directories')
      expect(prompt).toContain(WINDOWS_SANDBOX_FILESYSTEM_LIMITS)
    }
  })

  it('shows Windows limits only for an active sandbox shell, including the selected shell tool', () => {
    const settings: ExecutionPermissionSettings = { executionProfile: 'full_access', approvalPolicy: 'policy', fileAccessLimit: 'read_only' }
    const prompt = createPermissionPrompt(settings, 'win32', ['lexora_shell'])
    expect(prompt).toContain('lexora_shell commands run with a read-only OS sandbox policy')
    expect(prompt).toContain(WINDOWS_SANDBOX_FILESYSTEM_LIMITS)
    const networkOnly = createPermissionPrompt(settings, 'win32', ['lexora_web_fetch'])
    expect(networkOnly).not.toContain('commands run with a read-only OS sandbox policy')
    expect(networkOnly).not.toContain(WINDOWS_SANDBOX_FILESYSTEM_LIMITS)
    expect(networkOnly).toContain('including network requests, are automatically approved')
  })
})

describe('createBuddySession', () => {
  it('applies model-dependent tool availability on startup and model selection in a real session', async () => {
    const root = await createDirectory()
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false })
    const models = modelRuntime.getModels()
    const model = models[0]!
    const otherModel = models.find(candidate => candidate.provider !== model.provider)!
    await modelRuntime.setRuntimeApiKey(model.provider, 'offline-test-only')
    await modelRuntime.setRuntimeApiKey(otherModel.provider, 'offline-test-only')
    const image = createImageGenerationCapability({
      getRunId: () => 'run-1',
      service: {
        generate: async () => { throw new Error('No generation is expected') },
        supports: candidate => candidate.provider === otherModel.provider,
      },
    })
    const result = await createBuddySession({
      agentDir: join(root, 'agent'),
      branchId: 'branch-1',
      canonicalRoot: root,
      conversationId: 'conversation-1',
      conversationsDirectory: join(root, 'conversations'),
      cwd: root,
      ...createRuntimeOptions(),
      inProcessExtensions: [image.extension, createToolDiscoveryCapability(image.disclosure!).extension],
      model,
      modelRuntime,
      resources: emptyResources(),
    })
    try {
      expect(result.session.getActiveToolNames()).not.toContain('lexora_image_generate')
      await result.session.setModel(otherModel)
      expect(result.session.getActiveToolNames()).toContain('lexora_image_generate')
      await result.session.setModel(model)
      expect(result.session.getActiveToolNames()).not.toContain('lexora_image_generate')
    }
    finally {
      await result.shutdown('quit')
    }
  })

  it('removes image tools and request declarations when OpenAI authentication changes to ChatGPT sign-in', async () => {
    const root = await createDirectory()
    const credentials = new InMemoryCredentialStore()
    const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false })
    const model = modelRuntime.getModels('openai').find(model => model.api === 'openai-responses')!
    let credentialType: AuthType = 'api_key'
    const gateway = new OpenAiImageGenerationService({ modelRuntime, resolveCredentialMetadata: () => ({ type: credentialType, revision: 1 }) })
    const image = createImageGenerationCapability({
      getRunId: () => 'run-1',
      service: {
        generate: async () => { throw new Error('No generation is expected') },
        supports: model => gateway.supports(model),
      },
    })
    const prompts: string[] = []
    vi.spyOn(modelRuntime, 'streamSimple').mockImplementation((target, context) => {
      prompts.push(getCurrentSystemPrompt(context.messages))
      const stream = createAssistantMessageEventStream()
      const message: AssistantMessage = {
        role: 'assistant',
        api: target.api,
        model: target.id,
        provider: target.provider,
        timestamp: Date.now(),
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Done' }],
        usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      }
      queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message }))
      return stream
    })
    await credentials.modify(model.provider, async () => ({ type: 'api_key', key: 'fixture-key' }))
    const result = await createBuddySession({
      agentDir: join(root, 'agent'),
      branchId: 'branch-1',
      canonicalRoot: root,
      conversationId: 'conversation-1',
      conversationsDirectory: join(root, 'conversations'),
      cwd: root,
      ...createRuntimeOptions(),
      model,
      modelRuntime,
      resources: emptyResources(),
      inProcessExtensions: [image.extension, createToolDiscoveryCapability(image.disclosure!).extension],
    })
    try {
      for (const type of ['api_key', 'oauth', 'api_key'] as const) {
        credentialType = type
        await credentials.modify(model.provider, async () => type === 'api_key'
          ? { type, key: 'fixture-key' }
          : { type, access: 'fixture-subscription-token', refresh: 'fixture-refresh', expires: Date.now() + 3_600_000 })
        await result.session.prompt('Inspect the available tools')
        expect(result.session.getActiveToolNames().includes('lexora_image_generate')).toBe(type === 'api_key')
        expect(prompts.at(-1)?.includes('lexora_image_generate')).toBe(type === 'api_key')
      }
      expect(prompts).toHaveLength(3)
    }
    finally {
      await result.shutdown('quit')
    }
  })

  it('discloses skill metadata in the real Pi prompt without preloading bodies or references', async () => {
    const root = await createDirectory()
    const directory = join(root, 'skills', 'sample-workflow')
    await mkdir(directory, { recursive: true })
    const skillPath = join(directory, 'SKILL.md')
    await writeFile(skillPath, '---\nname: sample-workflow\ndescription: Inspect sample workflow inputs\n---\nBODY_ONLY_ON_DEMAND\nSee reference.md when needed.\n')
    await writeFile(join(directory, 'reference.md'), 'REFERENCE_ONLY_ON_DEMAND')
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    const skills = new SkillService({
      agentDirectory: join(root, 'agent'),
      builtinSkillsDirectories: [join(root, 'skills')],
      paths: new BuddyDataPaths(root),
      repository: createSkillRepository(database),
      spaces: createSpaceRepository(database),
    })
    const approved = await skills.loadForSpace(null)
    await skills.dispose()
    database.close()
    const outside = join(root, 'outside.md')
    await writeFile(outside, '---\nname: sample-workflow\ndescription: OUTSIDE_METADATA\n---\nOUTSIDE_BODY')
    await rm(skillPath)
    await symlink(outside, skillPath)
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false })
    const model = modelRuntime.getModels()[0]!
    const result = await createBuddySession({
      agentDir: join(root, 'agent'),
      branchId: 'branch-1',
      canonicalRoot: root,
      conversationId: 'conversation-1',
      conversationsDirectory: join(root, 'conversations'),
      cwd: root,
      ...createRuntimeOptions(),
      model,
      modelRuntime,
      resources: { ...emptyResources(), skillReadRoots: [], skillReferences: [], approvedSkills: approved.skills },
    })
    try {
      expect(result.session.systemPrompt).toContain('<name>sample-workflow</name>')
      expect(result.session.systemPrompt).toContain('Inspect sample workflow inputs')
      expect(result.session.systemPrompt).toContain(skillPath)
      expect(result.session.systemPrompt).not.toContain('BODY_ONLY_ON_DEMAND')
      expect(result.session.systemPrompt).not.toContain('REFERENCE_ONLY_ON_DEMAND')
      expect(result.session.systemPrompt).not.toContain('OUTSIDE_METADATA')
    }
    finally {
      await result.shutdown('quit')
    }
  })

  it.each<ExecutionPermissionSettings>([
    { executionProfile: 'workspace_write', approvalPolicy: 'policy' },
    { executionProfile: 'full_access', approvalPolicy: 'policy', fileAccessLimit: 'read_only' },
    { executionProfile: 'workspace_write', approvalPolicy: 'manual', fileAccessLimit: 'read_only' },
  ])('matches Windows permissions $executionProfile/$approvalPolicy/$fileAccessLimit in requests and context previews', async (permissions) => {
    const root = await createDirectory()
    const agentDir = join(root, '.lexora-buddy')
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false })
    const model = modelRuntime.getModels()[0]!
    await modelRuntime.setRuntimeApiKey(model.provider, 'offline-test-only')
    const options = {
      agentDir,
      branchId: 'branch-1',
      canonicalRoot: root,
      conversationId: 'conversation-1',
      conversationsDirectory: join(root, 'conversations'),
      cwd: root,
      ...createRuntimeOptions(),
      model,
      modelRuntime,
      platform: 'win32' as const,
      getPermissionSettings: () => permissions,
      resources: { ...emptyResources(), actorPrompt: 'WINDOWS_ACTOR_INSTRUCTIONS' },
    }
    const result = await createBuddySession(options)
    try {
      const snapshot = await createBuddyContextSnapshot(options)
      const requests: { prompt: string, usage: ReturnType<typeof createEstimatedContextUsage> }[] = []
      vi.spyOn(modelRuntime, 'streamSimple').mockImplementation((target, context) => {
        requests.push({ prompt: getCurrentSystemPrompt(context.messages), usage: createEstimatedContextUsage(context) })
        const stream = createAssistantMessageEventStream()
        const message: AssistantMessage = {
          role: 'assistant',
          api: target.api,
          model: target.id,
          provider: target.provider,
          timestamp: Date.now(),
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Done' }],
          usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        }
        queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message }))
        return stream
      })
      await result.session.prompt('Inspect the available tools')
      expect(result.session.getActiveToolNames().sort()).toEqual(['edit', 'find', 'grep', 'ls', 'powershell', 'read', 'write'])
      expect(requests).toHaveLength(1)
      expect(requests[0]!.prompt).toContain(createPermissionPrompt(permissions, 'win32', result.session.getActiveToolNames()))
      expect(requests[0]!.prompt).toContain(permissions.fileAccessLimit === 'read_only' ? 'PowerShell commands run with a read-only OS sandbox policy' : 'including PowerShell')
      expect(requests[0]!.prompt).not.toContain('including bash')
      expect(requests[0]!.prompt).toContain('WINDOWS_ACTOR_INSTRUCTIONS')
      expect(snapshot?.systemPromptTokens).toBe(requests[0]!.usage.systemPromptTokens)
    }
    finally {
      await result.shutdown('quit')
    }
  })

  it('does not estimate usage after a persisted Pi compaction without a later response', async () => {
    const root = await createDirectory()
    const agentDir = join(root, '.lexora-buddy')
    const conversationsDirectory = join(root, 'conversations')
    const modelRuntime = await ModelRuntime.create({
      modelsPath: null,
      refreshOnCreate: false,
    })
    const model = modelRuntime.getModels()[0]
    if (!model)
      throw new Error('Pi did not expose a built-in model for the test')
    const options = {
      agentDir,
      branchId: 'branch-1',
      canonicalRoot: root,
      conversationId: 'conversation-1',
      conversationsDirectory,
      cwd: root,
      ...createRuntimeOptions(),
      model,
      modelRuntime,
      resources: emptyResources(),
    }
    const session = await createBuddySession(options)
    const firstKeptEntryId = session.session.sessionManager.appendMessage({
      content: 'Context before compaction',
      role: 'user',
      timestamp: Date.now(),
    })
    session.session.sessionManager.appendMessage({
      api: model.api,
      content: [{ text: 'Answer before compaction', type: 'text' }],
      model: model.id,
      provider: model.provider,
      role: 'assistant',
      stopReason: 'stop',
      timestamp: Date.now(),
      usage: {
        cacheRead: 0,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input: 240_000,
        output: 10_000,
        totalTokens: 250_000,
      },
    })
    session.session.sessionManager.appendCompaction(
      'Compacted context',
      firstKeptEntryId,
      250_000,
    )
    await session.shutdown('quit')

    const snapshot = await createBuddyContextSnapshot({
      ...options,
      piSessionFile: session.piSessionFile,
    })

    expect(snapshot).toBeNull()
  })

  it('rejects invalid Buddy session identifiers before creating storage', async () => {
    const root = await createDirectory()

    await expect(createPreparedBuddySession({
      sessionManager: SessionManager.inMemory(root),
      agentDir: join(root, '.lexora-buddy'),
      branchId: '../escape',
      canonicalRoot: root,
      conversationId: 'conversation-1',
      conversationsDirectory: join(root, 'conversations'),
      cwd: root,
      ...createRuntimeOptions(),
      model: undefined,
      modelRuntime: {} as ModelRuntime,
      resources: emptyResources(),
    })).rejects.toMatchObject({ code: 'SESSION_BINDING_INVALID' })
  })
})

function createRuntimeOptions() {
  return {
    approvalPolicy: 'policy' as const,
    executionProfile: 'workspace_write' as const,
    inProcessExtensions: [],
  }
}

function emptyResources() {
  return {
    skillReadRoots: [],
    skillReferences: [],
    approvedSkills: [],
    context: { agentsFiles: [], diagnostics: [] },
    directoryContext: '',
    revision: 'empty',
  }
}

async function createDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'lexora-buddy-session-'))
  directories.push(path)
  return realpath(path)
}

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it } from 'vitest'
import { createImageGenerationCapability } from '../../../images/imageGenerationExtension'
import { SkillService } from '../../../skills/SkillService'
import { BuddyDataPaths } from '../../../storage/BuddyDataPaths'
import { openBuddyDatabase } from '../../../storage/database'
import { createSkillRepository } from '../../../storage/skillRepository'
import { createSpaceRepository } from '../../../storage/spaceRepository'
import { createToolDiscoveryCapability } from '../../extensions/discovery/toolDiscoveryExtension'

import { createBuddySession as createPreparedBuddySession } from '../createBuddySession'
import {
  createIsolatedBuddyContextSnapshot as createBuddyContextSnapshot,
  createIsolatedBuddySession as createBuddySession,
} from './isolatedBuddySession'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
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
      inProcessExtensions: [image.extension, createToolDiscoveryCapability([image.disclosure!]).extension],
      model,
      modelRuntime,
      resources: emptyResources(),
    })
    try {
      expect(result.session.getActiveToolNames()).not.toContain('lexora_image_generate')
      expect(result.session.getActiveToolNames()).toEqual(expect.arrayContaining(['read', 'write', 'find', 'grep', 'ls']))
      await result.session.setModel(otherModel)
      expect(result.session.getActiveToolNames()).not.toContain('lexora_image_generate')
      await result.session.getToolDefinition('lexora_tool_search')!.execute(
        'discover-image',
        { toolNames: ['lexora_image_generate'] },
        undefined,
        undefined,
        { model: otherModel } as never,
      )
      expect(result.session.getActiveToolNames()).toContain('lexora_image_generate')
      await result.session.setModel(model)
      expect(result.session.getActiveToolNames()).not.toContain('lexora_image_generate')
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
      expect(result.session.systemPrompt).toContain('<available_skills>')
      expect(result.session.systemPrompt).toContain('<name>sample-workflow</name>')
      expect(result.session.systemPrompt).toContain('Inspect sample workflow inputs')
      expect(result.session.systemPrompt).toContain(skillPath)
      expect(result.session.systemPrompt).toContain('Use the read tool to load a skill')
      expect(result.session.systemPrompt).not.toContain('BODY_ONLY_ON_DEMAND')
      expect(result.session.systemPrompt).not.toContain('REFERENCE_ONLY_ON_DEMAND')
      expect(result.session.systemPrompt).not.toContain('OUTSIDE_METADATA')
    }
    finally {
      await result.shutdown('quit')
    }
  })

  it('activates PowerShell instead of Bash for a Windows session', async () => {
    const root = await createDirectory()
    const agentDir = join(root, '.lexora-buddy')
    const modelRuntime = await ModelRuntime.create({
      modelsPath: null,
      refreshOnCreate: false,
    })
    const model = modelRuntime.getModels()[0]
    if (!model)
      throw new Error('Pi did not expose a built-in model for the test')

    const result = await createBuddySession({
      agentDir,
      branchId: 'branch-1',
      canonicalRoot: root,
      conversationId: 'conversation-1',
      conversationsDirectory: join(root, 'conversations'),
      cwd: root,
      ...createRuntimeOptions(),
      model,
      modelRuntime,
      platform: 'win32',
      resources: emptyResources(),
    })
    try {
      expect(result.session.getActiveToolNames().sort()).toEqual([
        'edit',
        'find',
        'grep',
        'ls',
        'powershell',
        'read',
        'write',
      ])
      expect(result.session.systemPrompt).toContain('including PowerShell')
      expect(result.session.systemPrompt).not.toContain('including bash')
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

import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { SkillInstallPreview } from '../../../../shared/skills/skillApi'
import type { DirectoryGrant } from '../../directories/resolveGrantedPath'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BuddyDataPaths } from '../../storage/BuddyDataPaths'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createSkillRepository } from '../../storage/skillRepository'
import { createSpaceRepository } from '../../storage/spaceRepository'
import { createSkillAuthoringCapability } from '../skillAuthoringCapability'
import { SkillService } from '../SkillService'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0))
    await dispose()
})

async function fixture(spaceId: string | null = 'space-a') {
  const root = await mkdtemp(join(tmpdir(), 'lexora-skill-author-'))
  const paths = new BuddyDataPaths(join(root, 'buddy'))
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  const spaces = createSpaceRepository(database)
  const conversations = createConversationRepository(database)
  const service = new SkillService({ agentDirectory: join(paths.root, 'agent'), paths, spaces, repository: createSkillRepository(database) })
  cleanup.push(async () => {
    await service.dispose()
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  const createdAt = '2026-10-09T00:00:00.000Z'
  spaces.create({ id: 'space-a', name: 'A', primaryDirectory: null, additionalDirectories: [], memoryScope: 'space_only', createdAt })
  conversations.create({ id: 'task', branchId: 'branch', spaceId, title: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt })
  const reviews: SkillInstallPreview[] = []
  const prepared: SkillInstallPreview[] = []
  const controller = new AbortController()
  const hooks: { afterPreview?: () => void | Promise<void>, reviewError?: Error } = {}
  let grants: readonly DirectoryGrant[] = [{ root, canonicalRoot: root, grantId: 'workspace', kind: 'workspace' }]
  let tool: ToolDefinition | undefined
  const capability = createSkillAuthoringCapability({ conversationId: 'task', cwd: root, executionProfile: 'workspace_write', getRunId: () => 'run', grants, getExecutionGrants: () => grants, sessionMode: 'interactive', signal: controller.signal }, {
    conversations,
    skills: {
      async preview(input, mode) {
        const result = await service.preview(input, mode)
        prepared.push(result)
        await hooks.afterPreview?.()
        return result
      },
      discard: id => service.discard(id),
    },
    requestReview(preview) {
      if (hooks.reviewError)
        throw hooks.reviewError
      reviews.push(preview)
    },
  })
  await capability.extension.factory({
    registerTool(value: ToolDefinition) {
      tool = value
    },
    on() {},
  } as never)
  async function source() {
    const directory = join(root, 'sources', 'writer')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), '---\nname: writer\ndescription: Summarize meeting notes and action items.\n---\n\nWrite a concise summary.\n')
    return directory
  }
  return { database, conversations, service, source, reviews, prepared, hooks, controller, capability, revokeGrants: () => {
    grants = []
  }, execute: (input: unknown, signal?: AbortSignal) => tool!.execute('call', input as never, signal, undefined, {} as never), install: (preview: SkillInstallPreview) => service.install({ previewId: preview.id, candidateIds: preview.candidates.map(item => item.id) }) }
}

describe('skill authoring', () => {
  it('validates without installing or leaving a usable preview token', async () => {
    const f = await fixture()
    const source = await f.source()
    const result = await f.execute({ source })
    expect(result.details).toMatchObject({ ok: true, name: 'writer', scope: 'space', spaceId: 'space-a', fileCount: 1, installation: 'not_requested', runtimeTested: false })
    expect(f.reviews).toEqual([])
    expect((await f.service.list('space-a')).skills).toEqual([])
    await expect(f.install(f.prepared[0]!)).rejects.toMatchObject({ code: 'SKILL_PREVIEW_EXPIRED' })
    expect(await readFile(join(source, 'SKILL.md'), 'utf8')).toContain('Write a concise summary.')
  })

  it.each([['space-a', 'global'], [null, undefined]] as const)('supports global installation from %s with scope %s', async (spaceId, scope) => {
    const f = await fixture(spaceId)
    expect((await f.execute({ source: await f.source(), scope, review: true })).details).toMatchObject({ ok: true, scope: 'global', spaceId: null })
    expect((await f.install(f.reviews[0]!)).skills[0]).toMatchObject({ source: 'global', spaceId: null })
  })

  it.each(['cancelled', 'deleted', 'moved', 'revoked'] as const)('rejects and releases a preview when the request becomes %s', async (change) => {
    const f = await fixture()
    f.hooks.afterPreview = () => {
      if (change === 'cancelled')
        f.controller.abort()
      if (change === 'deleted')
        f.conversations.markDeleted('task', '2026-10-09T01:00:00.000Z')
      if (change === 'moved')
        f.database.prepare('UPDATE conversations SET space_id = NULL WHERE id = ?').run('task')
      if (change === 'revoked')
        f.revokeGrants()
    }
    const result = await f.execute({ source: await f.source(), review: true })
    expect(result.details).toMatchObject({ ok: false, code: change === 'cancelled' ? 'SKILL_PREPARE_CANCELLED' : change === 'revoked' ? 'PATH_OUTSIDE_GRANTED_DIRECTORY' : 'SKILL_CHANGED' })
    expect(f.reviews).toEqual([])
    await expect(f.install(f.prepared[0]!)).rejects.toMatchObject({ code: 'SKILL_PREVIEW_EXPIRED' })
  })

  it('uses each invocation signal and releases a failed review without exposing internal errors', async () => {
    const f = await fixture()
    const source = await f.source()
    f.controller.abort()
    expect((await f.execute({ source }, new AbortController().signal)).details).toMatchObject({ ok: true })
    f.hooks.reviewError = new Error('private transport details')
    const result = await f.execute({ source, review: true }, new AbortController().signal)
    expect(result.details).toEqual({ ok: false, code: 'SKILL_PREPARE_FAILED' })
    await expect(f.install(f.prepared.at(-1)!)).rejects.toMatchObject({ code: 'SKILL_PREVIEW_EXPIRED' })
  })

  it('rejects an ungranted directory and a parent directory of skills', async () => {
    const f = await fixture()
    await f.source()
    expect((await f.execute({ source: tmpdir(), review: true })).details).toMatchObject({ ok: false, code: 'PATH_OUTSIDE_GRANTED_DIRECTORY' })
    expect((await f.execute({ source: 'sources', review: true })).details).toMatchObject({ ok: false, code: 'SKILL_INVALID' })
    expect(f.reviews).toEqual([])
  })

  it('rejects an empty body with authoring diagnostics without changing import compatibility', async () => {
    const f = await fixture()
    const source = await f.source()
    await writeFile(join(source, 'SKILL.md'), '---\nname: writer\ndescription: Useful task\n---\n')
    const result = await f.execute({ source, review: true })
    expect(result.details).toMatchObject({ ok: false, code: 'SKILL_INVALID', diagnostics: [expect.objectContaining({ code: 'SKILL_INVALID', path: join(source, 'SKILL.md'), message: expect.any(String) })] })
    expect(f.reviews).toEqual([])
    expect((await f.service.preview({ spaceId: null, source: { kind: 'directory', location: source } })).candidates).toHaveLength(1)
  })

  it('classifies review as a write and rejects invalid scopes at the tool boundary', async () => {
    const f = await fixture()
    const event = { type: 'tool_call' as const, toolCallId: 'call', toolName: 'lexora_skill_prepare', input: { source: 'sources/writer' } }
    expect(f.capability.classify(event, f.controller.signal)).toEqual({ access: 'read', paths: [{ path: 'sources/writer', mode: 'existing' }] })
    expect(f.capability.classify({ ...event, input: { ...event.input, review: true } }, f.controller.signal)).toMatchObject({ access: 'write' })
    expect((await f.execute({ source: 'sources/writer', scope: 'space-b', review: true })).details).toEqual({ ok: false, code: 'VALIDATION_FAILED' })
  })
})

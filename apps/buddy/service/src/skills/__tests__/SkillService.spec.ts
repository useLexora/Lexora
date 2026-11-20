import type { DatabaseSync } from 'node:sqlite'
import type { SkillEvent } from '../skillEvents'
import * as fs from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as boundedFile from '../../../../platform/filesystem/boundedFile'
import * as nativeBoundedFile from '../../../../platform/filesystem/nativeBoundedFile'
import { SessionResourceReconciler } from '../../agent/resources/SessionResourceReconciler'
import { BuddySessionRegistry } from '../../agent/sessions/BuddySessionRegistry'
import { BuddyDataPaths } from '../../storage/BuddyDataPaths'
import { openBuddyDatabase } from '../../storage/database'
import { createSkillRepository } from '../../storage/skillRepository'
import { createSpaceRepository } from '../../storage/spaceRepository'
import { observeSkillDiagnostics } from '../observeSkillEvents'
import { formatBuddySkillPrompt, SkillService } from '../SkillService'

const databases: DatabaseSync[] = []
const directories: string[] = []
const services: SkillService[] = []
const now = '2026-08-14T00:00:00.000Z'

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, watch: vi.fn(original.watch) }
})

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.dispose()))
  vi.restoreAllMocks()
  for (const database of databases.splice(0))
    database.close()
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('skillService', () => {
  it.each([true, false])('uses the current application Skill path after an upgrade and preserves enabled=%s', async (enabled) => {
    const fixture = await createFixture()
    await writeSkill(fixture.builtin, 'bundled', 'application skill')
    await fixture.service.list(null)
    const [installation] = fixture.repository.list()
    const oldRoot = join(fixture.root, 'previous-install')
    fixture.repository.save({ ...installation!, enabled, path: join(oldRoot, 'bundled/SKILL.md'), origin: { kind: 'application', location: oldRoot } })

    const path = join(fixture.builtin, 'bundled/SKILL.md')
    const skill = (await fixture.service.list(null, true)).skills[0]!
    expect(skill).toMatchObject({ id: installation!.id, enabled, filePath: path, origin: { kind: 'application', location: fixture.builtin } })
    if (enabled)
      expect((await fixture.service.materializeForSpace(null, ['bundled']))[0]?.filePath).toBe(path)
    else
      expect((await fixture.service.loadForSpace(null)).paths).not.toContain(path)
    await fixture.service.list(null)
    expect(fixture.repository.list()).toMatchObject([{ id: installation!.id, createdAt: installation!.createdAt, enabled, path }])
  })

  it('publishes source creation, document edits and removal', async () => {
    const fixture = await createFixture()
    fixture.spaces.create(spaceInput('space-trusted', fixture.trustedSpace))
    expect((await fixture.service.list('space-trusted', true)).skills).toEqual([])
    const events: SkillEvent[] = []
    fixture.service.onDidChange(event => events.push(event))
    const source = join(fixture.trustedSpace, '.agents', 'skills')
    await writeSkill(source, 'new', 'newly created')
    await vi.waitFor(() => expect(events.some(event => event.type === 'resources' && event.skillIds.length === 1)).toBe(true))
    await writeSkill(source, 'new', 'updated metadata')
    await vi.waitFor(async () => expect((await fixture.service.list('space-trusted', true)).skills[0]?.description).toBe('updated metadata'))
    await rm(join(source, 'new'), { recursive: true })
    await vi.waitFor(async () => expect((await fixture.service.list('space-trusted', true)).skills).toEqual([]))
  })

  it('keeps target validation active when filesystem notifications have not refreshed the catalog', async () => {
    const originalFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    await vi.mocked(fs.watch).withImplementation(path => originalFs.watch(path, { persistent: false }, () => {}), async () => {
      const fixture = await createFixture()
      await writeSkill(fixture.global, 'target', 'original metadata')
      const skill = (await fixture.service.list(null, true)).skills[0]!
      const original = await fixture.service.materializeForSpace(null, [{ id: skill.id, name: skill.name, revision: skill.referenceRevision! }])
      await writeSkill(fixture.global, 'target', 'changed metadata')
      expect((await fixture.service.list(null, true)).skills[0]?.description).toBe('original metadata')
      await expect(fixture.service.setEnabled({ spaceId: null, id: skill.id, revision: skill.managementRevision!, enabled: false })).rejects.toMatchObject({ code: 'SKILL_CHANGED' })
      await expect(fixture.service.materializeForSpace(null, original.map(item => item.reference))).rejects.toMatchObject({ code: 'SKILL_CHANGED' })
      await writeSkill(fixture.global, 'target', 'explicitly refreshed metadata')
      const refreshed = await fixture.service.list(null, true, true)
      expect(refreshed.skills[0]?.description).toBe('explicitly refreshed metadata')
    })
  })

  it('rescans a source when filesystem watching is unavailable', async () => {
    await vi.mocked(fs.watch).withImplementation(() => {
      throw Object.assign(new Error('watch limit'), { code: 'ENOSPC' })
    }, async () => {
      const fixture = await createFixture()
      await writeSkill(fixture.global, 'unwatched', 'initial metadata')
      expect((await fixture.service.list(null, true)).skills[0]?.description).toBe('initial metadata')
      await writeSkill(fixture.global, 'unwatched', 'current metadata')
      expect((await fixture.service.list(null, true)).skills[0]?.description).toBe('current metadata')
    })
  })

  it('delivers an accepted installation commit to its session consumer before shutdown', async () => {
    const fixture = await createFixture()
    await writeSkill(fixture.global, 'late-commit', 'fixture metadata')
    const sessions = new BuddySessionRegistry<{ shutdown: () => Promise<void> }>()
    const reconciler = new SessionResourceReconciler({ sessions, skills: fixture.service })
    const catalog = await fixture.service.list(null)
    const resolution = await fixture.service.loadForSpace(null)
    let closed = 0
    await sessions.getOrCreate({ approvalPolicy: 'policy', branchId: 'branch', canonicalRoot: '/workspace', conversationId: 'conversation', executionProfile: 'workspace_write', grantRevision: 'grant', resourceRevision: 'resource', skillRevision: resolution.revision, scratchRoot: '/scratch', sessionMode: 'interactive', spaceId: null }, null, async () => ({ piSessionFile: '/session', session: { shutdown: async () => {
      closed++
    } } }))
    await reconciler.whenIdle()
    const skill = catalog.skills[0]!
    const committed: SkillEvent[] = []
    fixture.service.onDidCommitInstallation(event => committed.push(event))
    const accepted = fixture.service.setEnabled({ spaceId: null, id: skill.id, revision: skill.revision, enabled: false })
    const stopping = reconciler.dispose()
    await accepted
    await stopping
    expect(committed).toHaveLength(1)
    expect(fixture.repository.list().find(record => record.id === skill.id)?.enabled).toBe(false)
    expect(closed).toBe(1)
    expect(sessions.getReady('conversation', 'branch')).toBeNull()
    await expect(fixture.service.setEnabled({ spaceId: null, id: skill.id, revision: skill.revision, enabled: true })).rejects.toMatchObject({ code: 'SKILL_CHANGED' })
    await fixture.service.dispose()
    await sessions.dispose()
  })

  it('accepts only the current scope generation when discovery resolves late', async () => {
    const fixture = await createFixture()
    await writeSkill(fixture.global, 'delayed', 'entry metadata')
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const read = nativeBoundedFile.readNativeBoundedFiles
    let delayed = false
    vi.spyOn(nativeBoundedFile, 'readNativeBoundedFiles').mockImplementation(async (...args) => {
      const contents = await read(...args)
      if (!delayed && args[0].length) {
        delayed = true
        entered.resolve()
        await resume.promise
      }
      return contents
    })
    const accepted: SkillEvent[] = []
    fixture.service.onDidAcceptCatalog(event => accepted.push(event))
    const old = fixture.service.list(null, true)
    await entered.promise
    const current = await fixture.service.list(null, true, true)
    resume.resolve()
    expect(await old).toEqual(current)
    expect(accepted).toHaveLength(1)
    expect(accepted[0]?.generation).toBeGreaterThan(0)
  })

  it('isolates returned catalogs, inspector details and effective resources from owner state', async () => {
    const fixture = await createFixture()
    await writeSkill(fixture.global, 'immutable', 'original metadata')
    const catalog = await fixture.service.list(null)
    const skill = catalog.skills[0]!
    expect(Reflect.set(skill, 'name', 'overwritten')).toBe(false)
    expect(Reflect.set(skill.origin!, 'location', '/untrusted')).toBe(false)
    expect(() => (catalog.skills as unknown as unknown[]).pop()).toThrow()
    const detail = await fixture.service.get(null, skill.id)
    expect(Reflect.set(detail.skill.origin!, 'location', '/untrusted')).toBe(false)
    const resolution = await fixture.service.loadForSpace(null)
    expect(Reflect.set(resolution.references[0]!, 'revision', 'overwritten')).toBe(false)
    expect((await fixture.service.get(null, skill.id)).skill.name).toBe('immutable')
    expect((await fixture.service.loadForSpace(null)).references[0]?.revision).toBe(resolution.references[0]?.revision)
  })

  it('keeps committed installations when observers fail and emits no same-value enable change', async () => {
    const failures: unknown[] = []
    const fixture = await createFixture(error => failures.push(error))
    const source = join(fixture.root, 'import-source')
    await writeSkill(source, 'installed', 'private skill description')
    const events: SkillEvent[] = []
    const diagnostics: unknown[] = []
    fixture.service.onDidCommitInstallation(() => {
      throw new Error('private observer contents')
    })
    fixture.service.onDidChange(event => events.push(event))
    observeSkillDiagnostics(fixture.service, event => diagnostics.push(event))
    const preview = await fixture.service.preview({ spaceId: null, source: { kind: 'directory', location: source } })
    const catalog = await fixture.service.install({ previewId: preview.id, candidateIds: preview.candidates.map(candidate => candidate.id) })
    const installed = catalog.skills.find(skill => skill.name === 'installed')!
    expect(installed.managedBy).toBe('user')
    expect(fixture.repository.list().find(record => record.id === installed.id)?.enabled).toBe(true)
    expect(events.filter(event => event.type === 'installation' && event.reason === 'installed')).toHaveLength(1)
    expect(events.some(event => event.type === 'cleanup' && event.status === 'cancelled')).toBe(true)
    expect(failures).toHaveLength(1)
    events.length = 0
    await fixture.service.setEnabled({ spaceId: null, id: installed.id, revision: installed.managementRevision!, enabled: true })
    expect(events).toEqual([])
    expect(JSON.stringify(diagnostics)).not.toContain(fixture.root)
    expect(JSON.stringify(diagnostics)).not.toContain('private')
  })

  it('reconciles actual effective scope changes while retaining sessions for management-only package updates', async () => {
    const fixture = await createFixture()
    await writeSkill(fixture.global, 'stable-entry', 'entry document')
    const guide = join(fixture.global, 'stable-entry', 'guide.md')
    await writeFile(guide, 'version one')
    const sessions = new BuddySessionRegistry<{ shutdown: () => Promise<void> }>()
    const reconciler = new SessionResourceReconciler({ sessions, skills: fixture.service })
    const events: SkillEvent[] = []
    fixture.service.onDidChange(event => events.push(event))
    const catalog = await fixture.service.list(null)
    await reconciler.whenIdle()
    const resources = await fixture.service.loadForSpace(null)
    let closes = 0
    await sessions.getOrCreate({ approvalPolicy: 'policy', branchId: 'branch', canonicalRoot: '/workspace', conversationId: 'conversation', executionProfile: 'workspace_write', grantRevision: 'grant-1', resourceRevision: 'resource-1', skillRevision: resources.revision, scratchRoot: '/scratch', sessionMode: 'interactive', spaceId: null }, null, async () => ({ piSessionFile: '/session', session: { shutdown: async () => {
      closes++
    } } }))
    await reconciler.whenIdle()
    events.length = 0
    await writeFile(guide, 'version two')
    const changed = await fixture.service.list(null)
    await reconciler.whenIdle()
    expect(changed.revision).not.toBe(catalog.revision)
    expect(events.some(event => event.type === 'catalog' && event.mode === 'management')).toBe(true)
    expect(events.some(event => event.type === 'resources')).toBe(false)
    expect(closes).toBe(0)
    const skill = changed.skills[0]!
    await fixture.service.setEnabled({ spaceId: null, id: skill.id, revision: skill.revision, enabled: false })
    await reconciler.whenIdle()
    expect(closes).toBe(1)
    expect(reconciler.snapshot()[0]?.status).toBe('current')
    await reconciler.dispose()
    await sessions.dispose()
  })

  it('loads built-in, authorized-directory and global skills with stable precedence', async () => {
    const fixture = await createFixture()
    await Promise.all([
      writeSkill(fixture.builtin, 'shared', 'built-in wins'),
      writeSkill(fixture.global, 'shared', 'global duplicate'),
      writeSkill(fixture.global, 'global-only', 'global skill'),
      writeSkill(fixture.global, 'layered', 'global duplicate'),
      writeSkill(join(fixture.trustedSpace, '.agents', 'skills'), 'layered', 'directory duplicate'),
      writeSkill(join(fixture.trustedSpace, '.agents', 'skills'), 'directory-agents', 'directory agents skill'),
      writeSkill(join(fixture.trustedSpace, '.pi', 'skills'), 'directory-pi', 'directory pi skill'),
    ])
    fixture.spaces.create(spaceInput('space-trusted', fixture.trustedSpace))

    const result = await fixture.service.loadForSpace('space-trusted')

    expect(result.skills.map(skill => [skill.name, skill.source])).toEqual([
      ['directory-agents', 'directory'],
      ['directory-pi', 'directory'],
      ['global-only', 'global'],
      ['layered', 'directory'],
      ['shared', 'global'],
    ])
    expect(result.skills.every(skill => skill.enabled)).toBe(true)
    expect(result.paths).toHaveLength(5)
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'SKILL_NAME_COLLISION' }))
  })

  it('refreshes changed skill documents without accepting an older selection', async () => {
    const fixture = await createFixture()
    await writeSkill(fixture.global, 'mutable', 'first revision')

    const first = await fixture.service.loadForSpace(null)
    await writeSkill(fixture.global, 'mutable', 'second revision')
    const second = await vi.waitFor(async () => {
      const current = await fixture.service.loadForSpace(null)
      expect(current.revision).not.toBe(first.revision)
      return current
    })

    expect(first.paths).toEqual(second.paths)
    await expect(fixture.service.materializeForSpace(null, first.references)).rejects.toMatchObject({ code: 'SKILL_CHANGED' })

    const third = await fixture.service.loadForSpace(null)
    expect(third.revision).not.toBe(first.revision)
    expect((await fixture.service.materializeForSpace(null, third.references))[0]?.body).toBe('# mutable')
  })

  it.each(['document', 'source'] as const)('rejects a cached %s replaced by a symlink outside its source', async (target) => {
    const fixture = await createFixture()
    const root = join(fixture.trustedSpace, '.agents', 'skills')
    await writeSkill(root, 'trusted', 'trusted metadata')
    fixture.spaces.create(spaceInput('space-trusted', fixture.trustedSpace))
    expect((await fixture.service.loadForSpace('space-trusted')).skills).toHaveLength(1)
    const outside = join(fixture.root, 'outside')
    await writeSkill(outside, 'trusted', 'outside metadata')
    const replaced = target === 'document' ? join(root, 'trusted', 'SKILL.md') : root
    const replacement = target === 'document' ? join(outside, 'trusted', 'SKILL.md') : outside
    await rm(replaced, { recursive: true })
    await symlink(replacement, replaced, target === 'source' ? 'junction' : 'file')

    await vi.waitFor(async () => {
      const current = await fixture.service.loadForSpace('space-trusted')
      expect(current.skills).toEqual([])
      expect(current.readRoots).toEqual([])
      expect(current.diagnostics.length).toBeGreaterThan(0)
    })
  })

  it('keeps discovery and the picker lightweight after a full management inspection', async () => {
    const fixture = await createFixture()
    await writeSkill(fixture.global, 'large', 'large skill')
    let nested = join(fixture.global, 'large')
    for (let depth = 0; depth < 18; depth++) {
      nested = join(nested, 'nested')
      await mkdir(nested)
    }
    await writeFile(join(nested, 'reference.md'), 'resource')
    const initial = await fixture.service.loadForSpace(null)
    expect(initial.skills.map(skill => skill.name)).toEqual(['large'])
    await fixture.service.list(null)
    const picker = await fixture.service.list(null, true)
    expect(picker.skills.map(skill => skill.name)).toEqual(['large'])
    expect((await fixture.service.loadForSpace(null)).revision).toBe(initial.revision)
    await writeSkill(fixture.global, 'new-skill', 'new skill')
    await vi.waitFor(async () => expect((await fixture.service.list(null, true)).skills.map(skill => skill.name)).toEqual(['large', 'new-skill']))
  })

  it('rejects revocation while a selected package is being materialized', async () => {
    const fixture = await createFixture()
    const root = join(fixture.trustedSpace, '.agents', 'skills')
    await writeSkill(root, 'trusted', 'trusted skill')
    const resource = join(root, 'trusted', 'reference.md')
    await writeFile(resource, 'reference')
    fixture.spaces.create(spaceInput('space-trusted', fixture.trustedSpace))
    const initial = await fixture.service.loadForSpace('space-trusted')
    const read = boundedFile.readBoundedFile
    vi.spyOn(boundedFile, 'readBoundedFile').mockImplementation(async (...args) => {
      const content = await read(...args)
      if (args[1] === resource) {
        fixture.spaces.update({
          id: 'space-trusted',
          name: 'Trusted',
          memoryScope: 'space_only',
          primaryDirectory: null,
          additionalDirectories: [],
          updatedAt: now,
          event: { id: 'revoke-during-load', eventType: 'space.config.updated', spaceId: 'space-trusted', createdAt: now, payload: {} },
        })
      }
      return content
    })

    await expect(fixture.service.materializeForSpace('space-trusted', initial.references)).rejects.toMatchObject({ code: 'SKILL_CHANGED' })
    expect((await fixture.service.loadForSpace('space-trusted')).skills).toEqual([])
  })

  it('unloads revoked Space skills and rejects symlink escapes', async () => {
    const fixture = await createFixture()
    const outside = join(fixture.root, 'outside')
    await writeSkill(join(fixture.trustedSpace, '.agents', 'skills'), 'trusted', 'trusted skill')
    await writeSkill(outside, 'escaped', 'outside skill')
    await mkdir(join(fixture.trustedSpace, '.pi'), { recursive: true })
    await symlink(outside, join(fixture.trustedSpace, '.pi', 'skills'))
    fixture.spaces.create(spaceInput('space-trusted', fixture.trustedSpace))

    const loaded = await fixture.service.loadForSpace('space-trusted')
    expect(loaded.skills.map(skill => skill.name)).toEqual(['trusted'])
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ code: 'SKILL_PATH_OUTSIDE_SOURCE' }))

    fixture.spaces.delete('space-trusted', now, {
      createdAt: now,
      eventType: 'space.deleted',
      id: 'event-delete-space-trusted',
      payload: {},
      spaceId: 'space-trusted',
    })
    await expect(fixture.service.loadForSpace('space-trusted')).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' })
    expect((await fixture.service.list(null)).skills).toEqual([])
  })

  it('does not make supporting resource changes part of the lightweight session revision', async () => {
    const fixture = await createFixture()
    await writeSkill(fixture.global, 'mutable', 'unchanged entry')
    const resource = join(fixture.global, 'mutable', 'guide.md')
    await writeFile(resource, 'version one')
    const first = await fixture.service.loadForSpace(null)
    const listed = await fixture.service.list(null)
    const listedSkill = listed.skills[0]!
    const packageReference = {
      id: listedSkill.id,
      name: listedSkill.name,
      revision: listedSkill.referenceRevision ?? listedSkill.revision,
      packageRevision: listedSkill.revision,
    }
    await writeFile(resource, 'version two')

    await expect(fixture.service.materializeForSpace(null, [packageReference])).rejects.toMatchObject({ code: 'SKILL_CHANGED' })
    expect((await fixture.service.materializeForSpace(null, first.references))[0]?.body).toBe('# mutable')
    const second = await fixture.service.loadForSpace(null)
    expect(second.revision).toBe(first.revision)
  })

  it('manages a skill from a metadata listing, including one that is not registered yet', async () => {
    const fixture = await createFixture()
    await writeSkill(fixture.global, 'fresh', 'newly discovered')
    await writeSkill(fixture.global, 'unrelated', 'another package')
    const listed = (await fixture.service.list(null, true)).skills.find(skill => skill.name === 'fresh')!

    const detail = await fixture.service.get(null, listed.id)
    expect(detail.skill.name).toBe('fresh')
    expect(fixture.repository.list()).toEqual([])
    const [selected] = await fixture.service.materializeForSpace(null, [{ id: listed.id, name: listed.name, revision: listed.revision }])
    expect(selected?.body).toBe('# fresh')

    const disabled = await fixture.service.setEnabled({ spaceId: null, id: listed.id, revision: listed.managementRevision!, enabled: false })
    expect(disabled.skills[0]).toMatchObject({ id: listed.id, enabled: false, status: 'disabled' })
    expect(fixture.repository.list().find(record => record.id === listed.id)?.enabled).toBe(false)
    expect(fixture.repository.list().map(record => record.name)).toEqual(['fresh'])
  })

  it('separates management revisions from document references and preserves full-package checks', async () => {
    const fixture = await createFixture()
    await writeSkill(fixture.global, 'either', 'dual revision')
    const full = (await fixture.service.list(null)).skills[0]!
    const light = (await fixture.service.list(null, true)).skills[0]!
    expect(full.revision).not.toBe(light.revision)

    await fixture.service.setEnabled({ spaceId: null, id: full.id, revision: light.managementRevision!, enabled: false })
    await fixture.service.setEnabled({ spaceId: null, id: full.id, revision: full.revision, enabled: true })
    await expect(fixture.service.setEnabled({ spaceId: null, id: full.id, revision: light.revision, enabled: false })).rejects.toMatchObject({ code: 'SKILL_CHANGED' })
    await expect(fixture.service.setEnabled({ spaceId: null, id: full.id, revision: 'unknown', enabled: false })).rejects.toMatchObject({ code: 'SKILL_CHANGED' })
    await writeFile(join(fixture.global, 'either', 'guide.md'), 'new supporting resource')
    await expect(fixture.service.setEnabled({ spaceId: null, id: full.id, revision: full.revision, enabled: false })).rejects.toMatchObject({ code: 'SKILL_CHANGED' })
    expect(fixture.repository.list()[0]?.enabled).toBe(true)
  })

  it('drains failed parallel reads before materialization and shutdown settle', async () => {
    const fixture = await createFixture()
    await writeSkill(fixture.global, 'parallel', 'parallel read fixture')
    const root = join(fixture.global, 'parallel')
    for (let index = 0; index < 20; index++)
      await writeFile(join(root, `resource-${String(index).padStart(2, '0')}.md`), 'fixture')
    const selected = (await fixture.service.list(null, true)).skills[0]!
    const started = Promise.withResolvers<void>()
    const cancelled = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const read = boundedFile.readBoundedFile
    const failure = new Error('fixture read failure')
    let active = 0
    vi.spyOn(boundedFile, 'readBoundedFile').mockImplementation(async (...args) => {
      if (args[1].endsWith('SKILL.md'))
        return read(...args)
      active++
      if (active === 2)
        started.resolve()
      args[3]?.addEventListener('abort', () => cancelled.resolve(), { once: true })
      try {
        if (args[1].endsWith('resource-00.md')) {
          await started.promise
          throw failure
        }
        await release.promise
        return await read(...args)
      }
      finally { active-- }
    })
    let settled = false
    const pending = fixture.service.materializeForSpace(null, [{ id: selected.id, name: selected.name, revision: selected.revision }]).finally(() => settled = true)
    const rejected = expect(pending).rejects.toBe(failure)
    try {
      await cancelled.promise
      let stopped = false
      const stopping = fixture.service.quiesce().then(() => stopped = true)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(settled).toBe(false)
      expect(stopped).toBe(false)
      release.resolve()
      await rejected
      await stopping
      expect(active).toBe(0)
    }
    finally {
      release.resolve()
      await rejected
    }
  })

  it('rejects a pending resolution when the Space directory binding is cleared', async () => {
    const fixture = await createFixture()
    await writeSkill(join(fixture.trustedSpace, '.agents', 'skills'), 'trusted', 'trusted skill')
    fixture.spaces.create(spaceInput('space-trusted', fixture.trustedSpace))
    const pending = fixture.service.loadForSpace('space-trusted')
    fixture.spaces.update({
      id: 'space-trusted',
      name: 'Trusted',
      memoryScope: 'space_only',
      primaryDirectory: null,
      additionalDirectories: [],
      updatedAt: now,
      event: { id: 'clear-directory', eventType: 'space.config.updated', spaceId: 'space-trusted', createdAt: now, payload: {} },
    })

    await expect(pending).rejects.toMatchObject({ code: 'SKILL_CHANGED' })
    expect((await fixture.service.loadForSpace('space-trusted')).skills).toEqual([])
  })

  it('does not let a skill file symlink leave its resolved skills directory', async () => {
    const fixture = await createFixture()
    const skillsDirectory = join(fixture.trustedSpace, '.agents', 'skills')
    const linkedSkillDirectory = join(skillsDirectory, 'linked')
    const siblingSkill = join(fixture.trustedSpace, 'private-skill.md')
    await mkdir(linkedSkillDirectory, { recursive: true })
    await writeFile(siblingSkill, [
      '---',
      'name: linked',
      'description: must stay private',
      '---',
      '',
      '# Private workflow',
    ].join('\n'))
    await symlink(siblingSkill, join(linkedSkillDirectory, 'SKILL.md'))
    fixture.spaces.create(spaceInput('space-trusted', fixture.trustedSpace))

    const result = await fixture.service.loadForSpace('space-trusted')

    expect(result.skills).toEqual([])
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'SKILL_INVALID' }))
  })

  it('materializes an explicitly selected skill even when model invocation is disabled', async () => {
    const fixture = await createFixture()
    const skillDirectory = join(fixture.builtin, 'manual-only')
    await mkdir(skillDirectory, { recursive: true })
    await writeFile(join(skillDirectory, 'SKILL.md'), [
      '---',
      'name: manual-only',
      'description: explicit only',
      'disable-model-invocation: true',
      '---',
      '',
      '# Manual workflow',
      '',
      'Follow the explicit workflow.',
    ].join('\n'))

    const [selected] = await fixture.service.materializeForSpace(null, ['manual-only'])

    expect(selected).toEqual({
      baseDirectory: skillDirectory,
      body: '# Manual workflow\n\nFollow the explicit workflow.',
      filePath: join(skillDirectory, 'SKILL.md'),
      name: 'manual-only',
      reference: expect.objectContaining({ name: 'manual-only' }),
    })
    expect(formatBuddySkillPrompt(selected!)).toBe([
      `<skill name="manual-only" location="${join(skillDirectory, 'SKILL.md')}">`,
      `References are relative to ${skillDirectory}.`,
      '',
      '# Manual workflow',
      '',
      'Follow the explicit workflow.',
      '</skill>',
    ].join('\n'))
    await expect(fixture.service.materializeForSpace(null, ['missing']))
      .rejects
      .toMatchObject({ code: 'SKILL_NOT_FOUND' })
  })
})

function spaceInput(id: string, root: string) {
  return {
    additionalDirectories: [],
    createdAt: now,
    id,
    memoryScope: 'personal_and_space' as const,
    name: id,
    primaryDirectory: {
      accessGrantedAt: now,
      canonicalRoot: root,
      id: `directory-${id}`,
      resourcesTrustedAt: now,
      root,
    },
  }
}

async function createFixture(onListenerError?: (error: unknown) => void) {
  const root = await mkdtemp(join(tmpdir(), 'lexora-buddy-skills-'))
  directories.push(root)
  const builtin = join(root, 'app', 'skills')
  const agentDirectory = join(root, 'buddy-agent')
  const global = join(agentDirectory, 'skills')
  const trustedSpace = join(root, 'trusted-space')
  await Promise.all([
    mkdir(builtin, { recursive: true }),
    mkdir(global, { recursive: true }),
    mkdir(trustedSpace, { recursive: true }),
  ])
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const spaces = createSpaceRepository(database)
  const repository = createSkillRepository(database)
  const service = new SkillService({ agentDirectory, builtinSkillsDirectories: [builtin], spaces, repository, onListenerError, paths: new BuddyDataPaths(join(root, 'buddy')) })
  services.push(service)
  return {
    repository,
    agentDirectory,
    builtin,
    global,
    spaces,
    root,
    service,
    trustedSpace,
  }
}

async function writeSkill(directory: string, name: string, description: string): Promise<void> {
  const skillDirectory = join(directory, name)
  await mkdir(skillDirectory, { recursive: true })
  await writeFile(join(skillDirectory, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    `# ${name}`,
  ].join('\n'))
}

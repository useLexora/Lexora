import { Buffer } from 'node:buffer'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BuddyDataPaths } from '../../storage/BuddyDataPaths'
import { openBuddyDatabase } from '../../storage/database'
import { createSkillRepository } from '../../storage/skillRepository'
import { createSpaceRepository } from '../../storage/spaceRepository'
import { extractSkillArchive } from '../skillImport'
import { SkillService } from '../SkillService'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dispose of cleanup.splice(0))
    await dispose()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'buddy-skill-install-'))
  const paths = new BuddyDataPaths(join(root, 'buddy'))
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  const repository = createSkillRepository(database)
  const spaces = createSpaceRepository(database)
  const builtin = join(root, 'application')
  await mkdir(builtin)
  const options = { agentDirectory: join(paths.root, 'agent'), paths, spaces, repository, builtinSkillsDirectories: [builtin] }
  const service = new SkillService(options)
  cleanup.push(async () => {
    await service.dispose()
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  spaces.create({ id: 'space-a', name: 'A', primaryDirectory: null, additionalDirectories: [], memoryScope: 'personal_and_space', createdAt: '2026-09-13T00:00:00.000Z' })
  async function source(name: string, body = 'Version one', extra = '') {
    const directory = join(root, 'sources', name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: A useful workflow\n${extra}---\n\n${body}\n`)
    return directory
  }
  async function install(directory: string, spaceId: string | null = null) {
    const preview = await service.preview({ spaceId, source: { kind: 'directory', location: directory } })
    const result = await service.install({ previewId: preview.id, candidateIds: preview.candidates.map(item => item.id) })
    return result.skills.find(skill => skill.spaceId === spaceId && skill.managedBy === 'user')!
  }
  return { root, paths, database, repository, spaces, options, service, source, install, builtin }
}

describe('skill installation lifecycle', () => {
  it('preserves the complete document and previews files only within the selected package', async () => {
    const f = await fixture()
    const source = await f.source('writer', '# Writing\n\n## Steps\n\n- Read\n- Summarize', 'license: MIT\nmetadata:\n  author: Example\n  version: "1.0"\n')
    await mkdir(join(source, 'references'))
    await writeFile(join(source, 'references', 'guide.md'), '# Reference\n\nA supporting document.')
    const skill = await f.install(source, 'space-a')
    const detail = await f.service.get('space-a', skill.id)
    expect(detail.content).toBe(await readFile(join(source, 'SKILL.md'), 'utf8'))
    expect(detail.metadata).toContainEqual({ name: 'license', value: 'MIT' })
    expect(detail.metadata).toContainEqual({ name: 'metadata', value: '{\n  "author": "Example",\n  "version": "1.0"\n}' })
    expect(detail.body).toContain('## Steps\n\n- Read\n- Summarize')
    const target = { spaceId: 'space-a', id: skill.id }
    expect((await f.service.listFiles({ ...target, path: '' })).entries.map(entry => entry.path)).toEqual(['references', 'SKILL.md'])
    expect((await f.service.listFiles({ ...target, path: 'references' })).entries[0]?.path).toBe('references/guide.md')
    expect(await f.service.readFile({ ...target, path: 'references/guide.md' })).toMatchObject({ kind: 'text', text: '# Reference\n\nA supporting document.' })
    const outside = join(f.root, 'private.txt')
    await writeFile(outside, 'Not part of the skill')
    await symlink(outside, join(dirname(skill.filePath), 'references', 'outside.txt'))
    expect((await f.service.listFiles({ ...target, path: 'references' })).entries.find(entry => entry.name === 'outside.txt')?.unavailable).toBe(true)
    for (const path of ['../private.txt', outside, 'references/outside.txt'])
      await expect(f.service.readFile({ ...target, path })).rejects.toMatchObject({ code: 'SKILL_INVALID' })
    await expect(f.service.readFile({ spaceId: null, id: skill.id, path: 'SKILL.md' })).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' })
  })

  it('revokes a remembered directory skill when the workspace binding changes', async () => {
    const f = await fixture()
    const source = await f.source('writer')
    const directory = join(f.root, 'project')
    const skillRoot = join(directory, '.agents', 'skills', 'writer')
    await mkdir(skillRoot, { recursive: true })
    await writeFile(join(skillRoot, 'SKILL.md'), await readFile(join(source, 'SKILL.md')))
    const now = '2026-09-14T00:00:00.000Z'
    f.spaces.create({ id: 'project-space', name: 'Project', memoryScope: 'space_only', primaryDirectory: { id: 'project-directory', root: directory, canonicalRoot: directory, accessGrantedAt: now, resourcesTrustedAt: now }, additionalDirectories: [], createdAt: now })
    const skill = (await f.service.list('project-space')).skills.find(skill => skill.source === 'directory')!
    expect((await f.service.get('project-space', skill.id)).body).toBe('Version one')
    const pending = f.service.get('project-space', skill.id)
    f.spaces.update({
      id: 'project-space',
      name: 'Project',
      memoryScope: 'space_only',
      primaryDirectory: null,
      additionalDirectories: [],
      updatedAt: now,
      event: { id: 'directory-cleared', eventType: 'space.config.updated', spaceId: 'project-space', createdAt: now, payload: {} },
    })
    await expect(pending).rejects.toMatchObject({ code: 'SKILL_CHANGED' })
    await expect(f.service.readFile({ spaceId: 'project-space', id: skill.id, path: 'SKILL.md' })).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' })
    await expect(f.service.get('project-space', skill.id)).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' })
  })

  it('installs without a workspace, preserves package resources and keeps selection identity across updates', async () => {
    const f = await fixture()
    const source = await f.source('writer')
    await mkdir(join(source, 'scripts'))
    await mkdir(join(source, 'references'))
    await writeFile(join(source, 'scripts', 'run.sh'), '#!/bin/sh\nprintf result\n')
    await chmod(join(source, 'scripts', 'run.sh'), 0o700)
    await writeFile(join(source, 'references', 'guide.md'), 'guide')
    const installed = await f.install(source, 'space-a')
    expect(installed).toMatchObject({ managedBy: 'user', source: 'space', status: 'available', canRemove: true })
    expect((await f.service.list(null)).skills).toEqual([])
    expect(await readFile(join(dirname(installed.filePath), 'references', 'guide.md'), 'utf8')).toBe('guide')
    expect((await stat(join(dirname(installed.filePath), 'scripts', 'run.sh'))).mode & 0o100).toBe(0o100)
    const ref = { id: installed.id, name: installed.name, revision: installed.revision }
    expect((await f.service.materializeForSpace('space-a', [ref]))[0]?.body).toBe('Version one')

    await f.service.setEnabled({ spaceId: 'space-a', id: installed.id, revision: installed.revision, enabled: false })
    await f.source('writer', 'Version two')
    const preview = await f.service.preview({ spaceId: 'space-a', updateId: installed.id, source: { kind: 'directory', location: source } })
    await f.source('writer', 'Changed after preview')
    const result = await f.service.install({ previewId: preview.id, candidateIds: [preview.candidates[0]!.id] })
    const updated = result.skills[0]!
    expect(updated).toMatchObject({ id: installed.id, enabled: false, status: 'disabled' })
    expect(updated.revision).not.toBe(installed.revision)
    expect((await f.service.get('space-a', updated.id)).body).toBe('Version two')
    await f.service.setEnabled({ spaceId: 'space-a', id: updated.id, revision: updated.revision, enabled: true })
    await expect(f.service.materializeForSpace('space-a', [ref])).rejects.toMatchObject({ code: 'SKILL_CHANGED' })
    await expect(stat(installed.filePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await f.service.remove({ spaceId: 'space-a', id: updated.id, revision: updated.revision })
    expect((await f.service.list('space-a')).skills).toEqual([])
    expect(await readFile(join(source, 'SKILL.md'), 'utf8')).toContain('Changed after preview')
  })

  it('inherits global enablement and rejects management through a space scope', async () => {
    const f = await fixture()
    const source = await f.source('writer')
    const global = await f.install(source)
    f.database.prepare('INSERT INTO skill_space_exclusions (skill_id, space_id) VALUES (?, ?)').run(global.id, 'space-a')
    expect((await f.service.list('space-a')).skills[0]).toMatchObject({ enabled: true, status: 'available', canRemove: false, canUpdate: false })
    await expect(f.service.setEnabled({ spaceId: 'space-a', id: global.id, revision: global.revision, enabled: false })).rejects.toMatchObject({ code: 'SKILL_READ_ONLY' })
    await expect(f.service.remove({ spaceId: 'space-a', id: global.id, revision: global.revision })).rejects.toMatchObject({ code: 'SKILL_READ_ONLY' })
    await expect(f.service.preview({ spaceId: 'space-a', updateId: global.id, source: { kind: 'directory', location: source } })).rejects.toMatchObject({ code: 'SKILL_READ_ONLY' })
    expect((await f.service.loadForSpace('space-a')).skills[0]?.id).toBe(global.id)
    await f.service.setEnabled({ spaceId: null, id: global.id, revision: global.revision, enabled: false })
    expect((await new SkillService(f.options).list('space-a')).skills[0]?.status).toBe('disabled')
    await f.service.setEnabled({ spaceId: null, id: global.id, revision: global.revision, enabled: true })
    expect((await new SkillService(f.options).loadForSpace('space-a')).skills[0]?.id).toBe(global.id)
    expect(f.database.prepare('SELECT skill_id FROM skill_space_exclusions WHERE space_id = ?').get('space-a')).toMatchObject({ skill_id: global.id })
  })

  it('reserves disabled or invalid higher-priority space entries', async () => {
    const f = await fixture()
    const source = await f.source('writer')
    const global = await f.install(source)
    const local = await f.install(source, 'space-a')
    await f.service.setEnabled({ spaceId: 'space-a', id: local.id, revision: local.revision, enabled: false })
    expect((await f.service.loadForSpace('space-a')).skills).toEqual([])
    expect((await f.service.list('space-a')).skills.find(skill => skill.id === global.id)?.status).toBe('shadowed')
    await f.service.setEnabled({ spaceId: 'space-a', id: local.id, revision: local.revision, enabled: true })
    await writeFile(local.filePath, 'broken')
    await f.service.list('space-a')
    expect((await f.service.loadForSpace('space-a')).skills).toEqual([])
    expect((await f.service.list('space-a')).skills.find(skill => skill.id === local.id)?.status).toBe('invalid')
  })

  it('keeps application packages immutable and allows same-name space installations', async () => {
    const f = await fixture()
    const source = await f.source('app-workflow')
    await mkdir(join(f.builtin, 'app-workflow'))
    await writeFile(join(f.builtin, 'app-workflow', 'SKILL.md'), await readFile(join(source, 'SKILL.md')))
    const app = (await f.service.list(null)).skills[0]!
    expect(app).toMatchObject({ source: 'global', managedBy: 'application', canRemove: false, canUpdate: false })
    await f.service.setEnabled({ spaceId: null, id: app.id, revision: app.revision, enabled: false })
    const preview = await f.service.preview({ spaceId: null, source: { kind: 'directory', location: source } })
    expect(preview.candidates[0]?.blocked).toBe(true)
    await expect(f.service.install({ previewId: preview.id, candidateIds: [preview.candidates[0]!.id] })).rejects.toMatchObject({ code: 'SKILL_INVALID' })
    await expect(f.service.remove({ spaceId: null, id: app.id, revision: app.revision })).rejects.toMatchObject({ code: 'SKILL_READ_ONLY' })
    expect((await f.service.loadForSpace(null)).skills).toEqual([])
    await f.source('app-workflow', 'Space instructions')
    const local = await f.install(source, 'space-a')
    expect((await f.service.loadForSpace('space-a')).skills.map(skill => skill.id)).toEqual([local.id])
    expect((await f.service.materializeForSpace('space-a', [{ id: local.id, name: local.name, revision: local.revision }]))[0]?.body).toBe('Space instructions')
    await f.service.setEnabled({ spaceId: null, id: app.id, revision: app.revision, enabled: true })
    expect((await f.service.list('space-a')).skills.find(skill => skill.id === app.id)).toMatchObject({ status: 'shadowed', enabled: true, shadowedBy: local.id })
    await f.service.setEnabled({ spaceId: 'space-a', id: local.id, revision: local.revision, enabled: false })
    expect((await f.service.loadForSpace('space-a')).skills).toEqual([])
    await f.service.remove({ spaceId: 'space-a', id: local.id, revision: local.revision })
    expect((await f.service.loadForSpace('space-a')).skills.map(skill => skill.id)).toEqual([app.id])
    expect((await f.service.get(null, app.id)).body).toBe('Version one')
  })

  it('uses a same-name directory skill ahead of space and application versions', async () => {
    const f = await fixture()
    const source = await f.source('app-workflow')
    await mkdir(join(f.builtin, 'app-workflow'))
    await writeFile(join(f.builtin, 'app-workflow', 'SKILL.md'), await readFile(join(source, 'SKILL.md')))
    const app = (await f.service.list(null)).skills[0]!
    const local = await f.install(source, 'space-a')
    const directory = join(f.root, 'project')
    const skillRoot = join(directory, '.agents', 'skills', 'app-workflow')
    await mkdir(skillRoot, { recursive: true })
    await writeFile(join(skillRoot, 'SKILL.md'), '---\nname: app-workflow\ndescription: Project workflow\n---\nDirectory instructions')
    const now = '2026-09-14T00:00:00.000Z'
    f.spaces.update({
      id: 'space-a',
      name: 'A',
      memoryScope: 'space_only',
      updatedAt: now,
      primaryDirectory: { id: 'directory', root: directory, canonicalRoot: directory, accessGrantedAt: now, resourcesTrustedAt: now },
      additionalDirectories: [],
      event: { id: 'bind-directory', eventType: 'space.config.updated', spaceId: 'space-a', createdAt: now, payload: {} },
    })
    const catalog = await f.service.list('space-a')
    const winner = catalog.skills.find(skill => skill.source === 'directory')!
    for (const id of [app.id, local.id])
      expect(catalog.skills.find(skill => skill.id === id)).toMatchObject({ status: 'shadowed', enabled: true, shadowedBy: winner.id })
    expect((await f.service.loadForSpace('space-a')).skills.map(skill => skill.id)).toEqual([winner.id])
    expect((await f.service.materializeForSpace('space-a', [{ id: winner.id, name: winner.name, revision: winner.revision }]))[0]?.body).toBe('Directory instructions')
    await expect(f.service.materializeForSpace('space-a', [{ id: app.id, name: app.name, revision: app.revision }])).rejects.toMatchObject({ code: 'SKILL_CHANGED' })
    await writeFile(join(skillRoot, 'SKILL.md'), 'broken')
    await f.service.list('space-a')
    expect((await f.service.loadForSpace('space-a')).skills).toEqual([])
    await rm(skillRoot, { recursive: true })
    await f.service.list('space-a')
    expect((await f.service.loadForSpace('space-a')).skills.map(skill => skill.id)).toEqual([local.id])
  })

  it('keeps the previous package on failed commit and cleans unpublished revisions after restart', async () => {
    const f = await fixture()
    const source = await f.source('writer')
    const installed = await f.install(source)
    await f.source('writer', 'Version two')
    const preview = await f.service.preview({ spaceId: null, updateId: installed.id, source: { kind: 'directory', location: source } })
    const failure = vi.spyOn(f.repository, 'saveAll').mockImplementationOnce(() => {
      throw new Error('Injected storage failure')
    })
    await expect(f.service.install({ previewId: preview.id, candidateIds: [preview.candidates[0]!.id] })).rejects.toMatchObject({ code: 'SKILL_INSTALL_FAILED' })
    failure.mockRestore()
    expect((await f.service.get(null, installed.id)).body).toBe('Version one')
    const orphan = join(f.paths.skillsDirectory(null), 'orphan-installation', 'uncommitted-revision')
    await mkdir(orphan, { recursive: true })
    await writeFile(join(orphan, 'pending.txt'), 'uncommitted')
    f.repository.scheduleCleanup(null, 'orphan-installation', orphan)
    await new SkillService(f.options).initialize()
    await expect(stat(orphan)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.repository.pendingCleanup()).toEqual([])
    expect(await readFile(installed.filePath, 'utf8')).toContain('Version one')
  })

  it('rejects updates and removal while a related run is active without changing files', async () => {
    const f = await fixture()
    const source = await f.source('writer')
    const installed = await f.install(source, 'space-a')
    f.database.exec(`INSERT INTO conversations (id, space_id, created_at, updated_at) VALUES ('task', 'space-a', 'now', 'now');
      INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES ('branch', 'task', 'now');
      INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at)
      VALUES ('run', 'task', 'branch', 'input', 'fixture', 'fixture', 'chat', 'running', 'now');`)
    await f.source('writer', 'Version two')
    const preview = await f.service.preview({ spaceId: 'space-a', updateId: installed.id, source: { kind: 'directory', location: source } })
    await expect(f.service.install({ previewId: preview.id, candidateIds: [preview.candidates[0]!.id] })).rejects.toMatchObject({ code: 'SKILL_BUSY' })
    await expect(f.service.remove({ spaceId: 'space-a', id: installed.id, revision: installed.revision })).rejects.toMatchObject({ code: 'SKILL_BUSY' })
    expect((await f.service.get('space-a', installed.id)).body).toBe('Version one')
  })

  it('rejects a stale update preview after the installed resource is edited', async () => {
    const f = await fixture()
    const source = await f.source('writer')
    const installed = await f.install(source)
    const preview = await f.service.preview({ spaceId: null, source: { kind: 'directory', location: source } })
    await writeFile(installed.filePath, (await readFile(installed.filePath, 'utf8')).replace('Version one', 'User edit'))
    await expect(f.service.install({ previewId: preview.id, candidateIds: [preview.candidates[0]!.id] })).rejects.toMatchObject({ code: 'SKILL_CHANGED' })
    expect((await f.service.get(null, installed.id)).body).toBe('User edit')
  })

  it('installs a GitHub subdirectory from its resolved commit and retains its origin', async () => {
    const f = await fixture()
    const commit = 'a'.repeat(40)
    const prefix = `workflows-${commit}/skills/writer`
    const archive = zipSync({
      [`${prefix}/SKILL.md`]: Buffer.from('---\nname: writer\ndescription: A writing workflow\n---\nFrom GitHub'),
      [`${prefix}/references/guide.md`]: Buffer.from('guide'),
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url) === 'https://api.github.com/repos/example/workflows/commits/release%2Fv1')
        return Response.json({ sha: commit })
      if (String(url) === `https://codeload.github.com/example/workflows/zip/${commit}`)
        return new Response(Buffer.from(archive))
      return new Response(null, { status: 404 })
    })
    const preview = await f.service.preview({ spaceId: null, source: { kind: 'github', location: 'example/workflows', ref: 'release/v1', subdirectory: 'skills/writer' } })
    expect(preview.source).toEqual({ kind: 'github', location: 'https://github.com/example/workflows', ref: 'release/v1', commit, subdirectory: 'skills/writer' })
    const result = await f.service.install({ previewId: preview.id, candidateIds: [preview.candidates[0]!.id] })
    const installed = result.skills[0]!
    expect(installed.origin).toEqual(preview.source)
    expect((await f.service.get(null, installed.id)).body).toBe('From GitHub')
    expect(await readFile(join(dirname(installed.filePath), 'references', 'guide.md'), 'utf8')).toBe('guide')
  })

  it('rejects traversal in downloaded archives and symlinks in local packages', async () => {
    const f = await fixture()
    await expect(extractSkillArchive(zipSync({ '../escaped.md': Buffer.from('escape') }), join(f.root, 'archive'))).rejects.toMatchObject({ code: 'SKILL_INVALID' })
    await expect(stat(join(f.root, 'escaped.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    const outside = join(f.root, 'private.md')
    await writeFile(outside, 'private content')
    const source = await f.source('linked')
    await symlink(outside, join(source, 'escape'))
    const invalid = await f.service.preview({ spaceId: null, source: { kind: 'directory', location: source } })
    expect(invalid.candidates).toEqual([])
    expect(invalid.diagnostics[0]?.code).toBe('SKILL_INVALID')
  })
})

import type { ExtensionSkillDescriptor } from '../../../../shared/extensions/extensionSkills'
import type { LocalSkill } from '../../../../shared/skills/skillApi'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Emitter } from '../../../../shared/events/Emitter'
import { skillInvocationName } from '../../../../shared/skills/skillApi'
import { BuddyDataPaths } from '../../storage/BuddyDataPaths'
import { openBuddyDatabase } from '../../storage/database'
import { createSkillRepository } from '../../storage/skillRepository'
import { createSpaceRepository } from '../../storage/spaceRepository'
import { SkillService } from '../SkillService'

const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
})

describe('plugin skills', () => {
  it('projects namespaced skills without installing copies or allowing independent management', async () => {
    const f = await fixture()
    const plugin = await f.package('author.genoffice', 'one')
    f.publish([plugin])
    const [skill] = (await f.service.list(null, true)).skills
    expect(skill).toMatchObject({ name: 'xlsx', invocationName: 'genoffice:xlsx', managedBy: 'plugin', source: 'global', canUpdate: false, canRemove: false })
    expect(skill?.plugin).toEqual({ extensionId: plugin.extensionId, extensionName: plugin.extensionName, contributionId: plugin.skills[0]!.id, revision: plugin.revision })
    const [materialized] = await f.service.materializeForSpace(null, [reference(skill!)])
    expect(materialized).toMatchObject({ name: 'genoffice:xlsx', body: 'Use the spreadsheet tools.', reference: { id: skill!.id, name: 'genoffice:xlsx' } })
    expect((await f.service.materializeForSpace(null, ['genoffice:xlsx']))[0]?.reference.id).toBe(skill!.id)
    await expect(f.service.materializeForSpace(null, ['xlsx'])).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' })
    await expect(f.service.setEnabled({ spaceId: null, id: skill!.id, revision: skill!.managementRevision!, enabled: false })).rejects.toMatchObject({ code: 'SKILL_READ_ONLY' })
    await expect(f.service.remove({ spaceId: null, id: skill!.id, revision: skill!.managementRevision! })).rejects.toMatchObject({ code: 'SKILL_READ_ONLY' })
    await expect(f.service.preview({ spaceId: null, updateId: skill!.id, source: { kind: 'directory', location: plugin.root } })).rejects.toMatchObject({ code: 'SKILL_READ_ONLY' })
    expect(f.repository.list()).toEqual([])
  })

  it('keeps same-name owners selectable by stable identity and rejects ambiguous text', async () => {
    const f = await fixture()
    const first = await f.package('first.genoffice', 'one')
    const second = await f.package('second.genoffice', 'one')
    const local = join(f.root, 'import', 'xlsx', 'SKILL.md')
    await mkdir(dirname(local), { recursive: true })
    await writeFile(local, document('Local spreadsheet workflow.'))
    const preview = await f.service.preview({ spaceId: null, source: { kind: 'directory', location: dirname(local) } })
    await f.service.install({ previewId: preview.id, candidateIds: preview.candidates.map(candidate => candidate.id) })
    f.publish([first, second])
    const skills = (await f.service.list(null, true)).skills
    expect(skills).toHaveLength(3)
    expect(skills.every(skill => skill.status === 'available')).toBe(true)
    await expect(f.service.materializeForSpace(null, ['genoffice:xlsx'])).rejects.toMatchObject({ code: 'SKILL_NAME_COLLISION' })
    const plugins = skills.filter(skill => skill.plugin)
    const materialized = await f.service.materializeForSpace(null, plugins.map(reference))
    expect(materialized).toHaveLength(2)
    expect(new Set(materialized.map(skill => skill.reference.id)).size).toBe(2)
    expect(materialized.every(skill => skill.name === 'genoffice:xlsx')).toBe(true)
    const localSkill = skills.find(skill => !skill.plugin)!
    expect(localSkill.managedBy).toBe('user')
    for (const selection of ['xlsx', reference(localSkill)])
      expect((await f.service.materializeForSpace(null, [selection]))[0]?.body).toBe('Local spreadsheet workflow.')
  })

  it('rejects old owners after disable or uninstall even before a change notification', async () => {
    const f = await fixture()
    const plugin = await f.package('author.genoffice', 'one')
    f.publish([plugin])
    const [skill] = (await f.service.list(null, true)).skills
    f.publish([{ ...plugin, enabled: false }], false)
    await expect(f.service.get(null, skill!.id)).rejects.toMatchObject({ code: 'SKILL_CHANGED' })
    expect((await f.service.list(null, true)).skills[0]?.status).toBe('disabled')
    expect((await f.service.loadForSpace(null)).skills).toEqual([])
    await expect(f.service.materializeForSpace(null, [reference(skill!)])).rejects.toMatchObject({ code: 'SKILL_CHANGED' })
    f.publish([plugin])
    expect((await f.service.list(null, true)).skills[0]?.id).toBe(skill!.id)
    f.publish([], false)
    await expect(f.service.readFile({ spaceId: null, id: skill!.id, path: 'references/guide.md' })).rejects.toMatchObject({ code: 'SKILL_CHANGED' })
    expect((await f.service.list(null, true)).skills).toEqual([])
    expect(f.repository.list()).toEqual([])
  })

  it('binds references and session resources to the plugin package when only a reference changes', async () => {
    const f = await fixture()
    const first = await f.package('author.genoffice', 'one')
    f.publish([first])
    const previous = await f.service.loadForSpace(null)
    const before = previous.skills[0]!
    const materialized = (await f.service.materializeForSpace(null, [reference(before)]))[0]!
    const next = await f.package('author.genoffice', 'two', 'Updated reference.')
    f.publish([next], false)
    await expect(f.service.materializeForSpace(null, [materialized.reference])).rejects.toMatchObject({ code: 'SKILL_CHANGED' })
    const current = await f.service.loadForSpace(null)
    expect(current.skills[0]?.id).toBe(before.id)
    expect(current.skills[0]?.referenceRevision).not.toBe(before.referenceRevision)
    expect(current.revision).not.toBe(previous.revision)
    expect((await f.service.get(null, before.id)).body).toBe('Use the spreadsheet tools.')
  })

  it.each(['changed', 'extra', 'missing', 'symlink'] as const)('rejects %s package resources during materialization and inspection', async (change) => {
    const f = await fixture()
    const plugin = await f.package('author.genoffice', 'one')
    f.publish([plugin])
    const skill = (await f.service.list(null, true)).skills[0]!
    const resource = join(plugin.root, 'skills/xlsx/references/guide.md')
    if (change === 'changed')
      await writeFile(resource, 'Unreviewed replacement.')
    if (change === 'extra')
      await writeFile(join(dirname(resource), 'unreviewed.md'), 'Extra resource.')
    if (change === 'missing')
      await rm(resource)
    if (change === 'symlink') {
      const outside = join(f.root, 'outside.md')
      await writeFile(outside, 'Original reference.')
      await rm(resource)
      await symlink(outside, resource)
    }
    await expect(f.service.materializeForSpace(null, [reference(skill)])).rejects.toThrow()
    await expect(f.service.get(null, skill.id)).rejects.toThrow()
  })

  it('does not let a skill inspect its sibling package files', async () => {
    const f = await fixture()
    const plugin = await f.package('author.genoffice', 'one')
    await writeFile(join(plugin.root, 'secret.json'), '{}')
    f.publish([plugin])
    const skill = (await f.service.list(null, true)).skills[0]!
    expect((await f.service.listFiles({ spaceId: null, id: skill.id, path: '' })).entries.map(entry => entry.name)).toEqual(['references', 'SKILL.md'])
    await expect(f.service.readFile({ spaceId: null, id: skill.id, path: '../../secret.json' })).rejects.toMatchObject({ code: 'SKILL_INVALID' })
  })
})

function reference(skill: LocalSkill) {
  return { id: skill.id, name: skillInvocationName(skill), revision: skill.referenceRevision ?? skill.revision }
}

function document(body = 'Use the spreadsheet tools.') {
  return `---\nname: xlsx\ndescription: Edit spreadsheet files.\n---\n\n${body}\n`
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lexora-plugin-skills-'))
  const agentDirectory = join(root, 'agent')
  await mkdir(agentDirectory, { recursive: true })
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  const repository = createSkillRepository(database)
  const changed = new Emitter<void>(() => {})
  let descriptors: ExtensionSkillDescriptor[] = []
  const service = new SkillService({
    agentDirectory,
    paths: new BuddyDataPaths(join(root, 'buddy')),
    repository,
    spaces: createSpaceRepository(database),
    pluginSkills: { list: async () => descriptors, onDidChange: changed.event },
  })
  cleanup.push(async () => {
    await service.dispose()
    changed.dispose()
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    repository,
    service,
    publish(value: ExtensionSkillDescriptor[], notify = true) {
      descriptors = value
      if (notify)
        changed.fire(undefined)
    },
    async package(extensionId: string, revision: string, guide = 'Original reference.'): Promise<ExtensionSkillDescriptor> {
      const directory = join(root, 'packages', extensionId, revision)
      const files = { 'skills/xlsx/SKILL.md': document(), 'skills/xlsx/references/guide.md': guide }
      for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(directory, path)), { recursive: true })
        await writeFile(join(directory, path), content)
      }
      return {
        extensionId,
        extensionName: 'GenOffice',
        revision,
        root: directory,
        enabled: true,
        skills: [{ id: `${extensionId}.xlsx`, path: 'skills/xlsx/SKILL.md' }],
        hashes: Object.fromEntries(Object.entries(files).map(([path, content]) => [path, createHash('sha256').update(content).digest('hex')])),
      }
    },
  }
}

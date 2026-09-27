import type { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { BuddyDataPaths } from '../../storage/BuddyDataPaths'
import { openBuddyDatabase } from '../../storage/database'
import { createSkillRepository } from '../../storage/skillRepository'
import { createSpaceRepository } from '../../storage/spaceRepository'
import { formatBuddySkillPrompt, SkillService } from '../SkillService'

const databases: DatabaseSync[] = []
const directories: string[] = []
const now = '2026-08-14T00:00:00.000Z'

afterEach(async () => {
  for (const database of databases.splice(0))
    database.close()
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('skillService', () => {
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

  it('reuses lightweight metadata and invalidates it when a selected skill document changes', async () => {
    const fixture = await createFixture()
    await writeSkill(fixture.global, 'mutable', 'first revision')

    const first = await fixture.service.loadForSpace(null)
    await writeSkill(fixture.global, 'mutable', 'second revision')
    const second = await fixture.service.loadForSpace(null)

    expect(first.paths).toEqual(second.paths)
    expect(second.revision).toBe(first.revision)
    await expect(fixture.service.materializeForSpace(null, first.references)).rejects.toMatchObject({ code: 'SKILL_CHANGED' })

    const third = await fixture.service.loadForSpace(null)
    expect(third.revision).not.toBe(first.revision)
    expect((await fixture.service.materializeForSpace(null, third.references))[0]?.body).toBe('# mutable')
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

async function createFixture() {
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
  return {
    agentDirectory,
    builtin,
    global,
    spaces,
    root,
    service: new SkillService({
      agentDirectory,
      builtinSkillsDirectories: [builtin],
      spaces,
      repository: createSkillRepository(database),
      paths: new BuddyDataPaths(join(root, 'buddy')),
    }),
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

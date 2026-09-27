import { chmod, mkdir, mkdtemp, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as boundedFile from '../../../../platform/filesystem/boundedFile'
import { readSkill } from '../skillFiles'
import { SkillPackageCache } from '../SkillPackageCache'

const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('skillPackageCache', () => {
  it('loads skill metadata without traversing bundled resources', async () => {
    const f = await fixture()
    await rm(join(f.root, 'references'), { recursive: true })
    let nested = f.root
    for (let depth = 0; depth < 18; depth++) {
      nested = join(nested, `level-${depth}`)
      await mkdir(nested)
    }
    await writeFile(join(nested, 'guide.md'), 'resource')

    const metadata = await f.cache.loadMetadata(f.path, f.root)

    expect(metadata.name).toBe('workflow')
    expect(metadata.description).toBe('A local workflow')
    expect(metadata.referenceRevision).toBeTruthy()
    await expect(f.cache.load(f.path, f.root)).rejects.toMatchObject({ code: 'SKILL_TOO_LARGE' })
  })

  it('shares a complete revision across concurrent loads and reuses unchanged packages without reading content', async () => {
    const f = await fixture()
    const expected = await readSkill(f.path, f.root)
    const read = vi.spyOn(boundedFile, 'readBoundedFile')

    const results = await Promise.all(Array.from({ length: 8 }, () => f.cache.load(f.path, f.root)))

    expect(results.every(skill => skill.revision === expected.revision && skill.body === expected.body)).toBe(true)
    expect(read).toHaveBeenCalledTimes(3)
    read.mockImplementation(async () => {
      throw new Error('Unchanged package content must not be read')
    })
    expect(await f.cache.load(f.path, f.root)).toEqual(results[0])
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('detects resource edits with the same size and restored modification time', async () => {
    const f = await fixture()
    const first = await f.cache.load(f.path, f.root)
    const metadata = await stat(f.resource)
    await writeFile(f.resource, 'version two')
    await utimes(f.resource, metadata.atime, metadata.mtime)

    const second = await f.cache.load(f.path, f.root)

    expect(second.body).toBe(first.body)
    expect(second.revision).not.toBe(first.revision)
    expect(second.revision).toBe((await readSkill(f.path, f.root)).revision)
  })

  it('updates the full revision for resource additions, renames and removals', async () => {
    const f = await fixture()
    const initial = await f.cache.load(f.path, f.root)
    const added = join(f.root, 'references', 'extra.md')
    const moved = join(f.root, 'references', 'renamed.md')
    await writeFile(added, 'new reference')
    const withAdded = await f.cache.load(f.path, f.root)
    await rename(added, moved)
    const withRenamed = await f.cache.load(f.path, f.root)
    await rm(moved)
    const withRemoved = await f.cache.load(f.path, f.root)

    expect(new Set([initial.revision, withAdded.revision, withRenamed.revision]).size).toBe(3)
    expect(withRemoved.revision).toBe(initial.revision)
  })

  it.skipIf(process.platform === 'win32')('includes executable permission changes in the revision', async () => {
    const f = await fixture()
    await chmod(f.resource, 0o600)
    const initial = await f.cache.load(f.path, f.root)
    await chmod(f.resource, 0o700)
    const executable = await f.cache.load(f.path, f.root)

    expect(executable.revision).not.toBe(initial.revision)
    expect(executable.revision).toBe((await readSkill(f.path, f.root)).revision)
  })

  it('does not reuse a cached package for an unauthorized root or after a resource becomes a symlink', async () => {
    const f = await fixture()
    await f.cache.load(f.path, f.root)
    const outside = await mkdtemp(join(tmpdir(), 'buddy-skill-outside-'))
    directories.push(outside)
    await expect(f.cache.load(f.path, outside)).rejects.toMatchObject({ code: 'SKILL_INVALID' })
    await writeFile(join(outside, 'private.md'), 'private')
    await rm(f.resource)
    await symlink(join(outside, 'private.md'), f.resource)

    await expect(f.cache.load(f.path, f.root)).rejects.toMatchObject({ code: 'SKILL_INVALID' })
  })

  it('rejects an unstable read and recovers without retaining the partial revision', async () => {
    const f = await fixture()
    const read = boundedFile.readBoundedFile
    let changed = false
    vi.spyOn(boundedFile, 'readBoundedFile').mockImplementation(async (...args) => {
      const content = await read(...args)
      if (args[1] === f.resource && !changed) {
        changed = true
        await writeFile(f.resource, 'version two')
      }
      return content
    })
    await expect(f.cache.load(f.path, f.root)).rejects.toMatchObject({ code: 'SKILL_CHANGED' })
    const recovered = await f.cache.load(f.path, f.root)

    expect(recovered.revision).toBe((await readSkill(f.path, f.root)).revision)
    expect(await f.cache.load(f.path, f.root)).toEqual(recovered)
  })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'buddy-skill-cache-'))
  directories.push(root)
  const path = join(root, 'SKILL.md')
  const resource = join(root, 'references', 'guide.md')
  await mkdir(join(root, 'references'))
  await writeFile(path, '---\nname: workflow\ndescription: A local workflow\n---\n\nFollow the workflow.')
  await writeFile(resource, 'version one')
  return { root, path, resource, cache: new SkillPackageCache() }
}

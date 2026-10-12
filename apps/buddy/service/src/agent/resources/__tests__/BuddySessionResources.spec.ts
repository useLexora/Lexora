import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveBuddySessionResources } from '../BuddySessionResources'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('buddySessionResources', () => {
  it('keeps a stable revision until trusted directory context changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lexora-buddy-resources-'))
    const additionalRoot = await mkdtemp(join(tmpdir(), 'lexora-buddy-additional-'))
    directories.push(root, additionalRoot)
    await writeFile(join(root, 'AGENTS.md'), 'First resource revision')
    const resolveResources = () => resolveBuddySessionResources({
      additionalDirectories: [{ canonicalRoot: additionalRoot }],
      canonicalRoot: root,
      cwd: root,
      loadDirectoryContext: true,
      primaryDirectory: { canonicalRoot: root },
      skills: {
        materializeForSpace: async () => [],
        loadForSpace: async () => ({
          diagnostics: [],
          readRoots: [],
          references: [],
          paths: [],
          revision: 'skills-revision-1',
          skills: [],
        }),
      },
      spaceId: 'space-1',
    })

    const first = await resolveResources()
    const unchanged = await resolveResources()
    await writeFile(join(root, 'AGENTS.md'), 'Second resource revision')
    const changed = await resolveResources()

    expect(first.directoryContext).toContain(`Working directory: ${root}`)
    expect(first.directoryContext).toContain(additionalRoot)
    expect(unchanged.revision).toBe(first.revision)
    expect(changed.revision).not.toBe(first.revision)
  })
})

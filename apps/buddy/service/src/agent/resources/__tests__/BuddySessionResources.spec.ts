import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_BUDDY_SETTINGS } from '../../../../../shared/buddies/buddySettings'
import { buddyExecutionDefinitionSchema } from '../../../buddies/BuddyExecutionDefinition'
import { resolveBuddySessionResources } from '../BuddySessionResources'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('buddySessionResources', () => {
  it('separates root and delegated session revisions without inventing a legacy name or changing compaction resources', async () => {
    const actor = buddyExecutionDefinitionSchema.parse({ version: 1, id: 'legacy-actor', kind: 'actor', revision: 1, settings: DEFAULT_BUDDY_SETTINGS, model: { providerId: 'fixture', modelId: 'fixture', reasoning: null, serviceTier: null }, modelSource: 'definition' })
    const options = {
      actor,
      additionalDirectories: [],
      canonicalRoot: '/workspace',
      cwd: '/workspace',
      loadDirectoryContext: false,
      primaryDirectory: null,
      skills: {
        materializeForSpace: async () => [],
        loadForSpace: async () => ({ diagnostics: [], readRoots: [], references: [], paths: [], revision: 'skills', skills: [] }),
      },
      spaceId: null,
    }
    const root = await resolveBuddySessionResources(options)
    const child = await resolveBuddySessionResources({ ...options, executionKind: 'actor_child' })
    const compact = await resolveBuddySessionResources({ ...options, executionKind: 'actor_child', contextMode: 'compaction' })
    expect(root.actorPrompt).toContain('Buddy ID: "legacy-actor"')
    expect(root.actorPrompt).not.toContain('Name:')
    expect(child.revision).not.toBe(root.revision)
    expect(compact.actorPrompt).toBe('')
    expect(compact.skillReferences).toEqual([])
  })

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

  describe('wsl directories', () => {
    const skills = {
      materializeForSpace: async () => [],
      loadForSpace: async () => ({ diagnostics: [], readRoots: [], references: [], paths: [], revision: 'skills', skills: [] }),
    }
    const resolveContext = async (root: string, additional: string[] = []) => (await resolveBuddySessionResources({
      additionalDirectories: additional.map(canonicalRoot => ({ canonicalRoot })),
      canonicalRoot: root,
      cwd: root,
      loadDirectoryContext: false,
      primaryDirectory: { canonicalRoot: root },
      skills,
      spaceId: 'space-1',
    }))
    const wslRoot = String.raw`\\wsl.localhost\Ubuntu-24.04\home\lenovo\code\Foo`

    it('tells the agent to run commands through wsl.exe with the Linux path', async () => {
      const { directoryContext, revision } = await resolveContext(wslRoot)
      expect(directoryContext).toContain(`- ${wslRoot} = Ubuntu-24.04:/home/lenovo/code/Foo`)
      expect(directoryContext).toContain('wsl.exe -d Ubuntu-24.04 --cd /home/lenovo/code/Foo --exec <program> <args>')
      expect(directoryContext).toContain(String.raw`\\wsl.localhost\Ubuntu-24.04\tmp\<unique-name>.sh`)
      expect(directoryContext.match(/- \\\\wsl/g)).toHaveLength(1)
      expect((await resolveContext('/workspace')).revision).not.toBe(revision)
    })

    it('also notes a WSL directory that is only an additional directory', async () => {
      const { directoryContext } = await resolveContext('/workspace', [String.raw`\\wsl$\Debian\var\log`])
      expect(directoryContext).toContain('= Debian:/var/log')
      expect(directoryContext).toContain('wsl.exe -d Debian --cd /var/log --exec')
    })

    it('leaves the directory context of other spaces unchanged', async () => {
      const { directoryContext } = await resolveContext('/workspace', ['/data'])
      expect(directoryContext).toBe(['Working directory: /workspace', 'Primary Space directory: /workspace', 'Additional authorized directories (access only; not preloaded as context):', '- /data', 'Inspect an additional directory only when the task requires files from it.'].join('\n'))
    })
  })
})

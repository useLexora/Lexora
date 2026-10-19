import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseDirectorySearch, searchDirectoryEntries } from '../searchDirectoryEntries'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'buddy-directory-search-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const grant = { canonicalRoot: workspace, root: workspace, grantId: 'workspace', kind: 'workspace' as const }
  return { root, workspace, search: (query: string, deep = false) => {
    const parsed = parseDirectorySearch(query, workspace)
    return searchDirectoryEntries(grant, parsed.path, parsed.term, deep)
  } }
}

describe('directory browsing and explicit deep search', () => {
  it('keeps direct children ahead of nested matches and scopes deep search to the browsed directory', async () => {
    const { workspace, search } = await fixture()
    await mkdir(join(workspace, 'apps', 'nested'), { recursive: true })
    await mkdir(join(workspace, '.playwright', 'runs', '2026-app-check'), { recursive: true })
    await writeFile(join(workspace, 'apps', 'nested', 'api.ts'), 'fixture')
    expect((await search('ap')).entries.map(entry => entry.name)).toEqual(['apps'])
    expect((await search('ap', true)).entries.map(entry => entry.name)).toEqual(['apps', 'api.ts', '2026-app-check', 'nested'])
    expect((await search('apps/ap')).entries).toEqual([])
    expect((await search('apps/ap', true)).entries.map(entry => entry.name)).toEqual(['api.ts'])
    expect((await search('apps/')).entries.map(entry => entry.name)).toEqual(['nested'])
  })

  it('ranks before limiting results so early substring matches cannot crowd out a prefix', async () => {
    const { workspace, search } = await fixture()
    await Promise.all(Array.from({ length: 65 }, (_, index) => writeFile(join(workspace, `a-ap-${index}.txt`), 'fixture')))
    await mkdir(join(workspace, 'apps'))
    const result = await search('ap')
    expect(result.entries).toHaveLength(50)
    expect(result.entries[0]!.name).toBe('apps')
    expect(result.hasMore).toBe(true)
  })

  it('skips ignored trees during deep search but permits deliberate browsing without a format filter', async () => {
    const { workspace, search } = await fixture()
    await mkdir(join(workspace, 'node_modules'))
    await writeFile(join(workspace, 'node_modules', 'asset.avif'), 'fixture')
    expect((await search('avif', true)).entries).toEqual([])
    expect((await search('node_modules/')).entries.map(entry => entry.name)).toEqual(['asset.avif'])
  })

  it('rejects traversal and escaping symlinks while exposing ordinary dotfiles', async () => {
    const { root, workspace, search } = await fixture()
    await writeFile(join(root, 'outside.txt'), 'outside')
    await writeFile(join(workspace, '.env'), 'synthetic')
    await writeFile(join(workspace, '.env.example'), 'synthetic')
    await symlink(join(root, 'outside.txt'), join(workspace, 'escape.txt'))
    expect((await search('')).entries.map(entry => entry.name)).toEqual(['.env', '.env.example'])
    await expect(search('../')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_GRANTED_DIRECTORY' })
  })
})

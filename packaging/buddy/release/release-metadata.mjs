import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseLexoraVersion } from '../../release/version.mjs'

const repoRoot = resolve(import.meta.dirname, '../../..')

export function readBuddyProductMetadata(cwd = repoRoot) {
  const { version } = JSON.parse(readFileSync(join(cwd, 'apps/buddy/buddy.version.json'), 'utf8'))
  const { repository } = JSON.parse(readFileSync(join(cwd, 'apps/buddy/package.json'), 'utf8'))
  const repositoryUrl = repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
  const { beta } = parseLexoraVersion(version)
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repositoryUrl))
    throw new Error('Buddy repository URL must identify its GitHub repository')
  return { version, prerelease: beta !== null, releaseTag: `v${version}`, releaseRepo: new URL(repositoryUrl).pathname.slice(1) }
}

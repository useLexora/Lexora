import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { downloadGithubReleaseAsset } from './github-release-download.mjs'

const require = createRequire(new URL('../../../apps/buddy/package.json', import.meta.url))

export async function prepareElectronDownload({ cacheRoot } = {}) {
  const electronRequire = createRequire(require.resolve('electron/package.json'))
  const { version } = electronRequire('./package.json')
  const archive = `electron-v${version}-${process.platform}-${process.arch}.zip`
  const checksum = electronRequire('./checksums.json')[archive]
  if (!/^[a-f0-9]{64}$/.test(checksum ?? ''))
    throw new Error(`Missing locked Electron checksum: ${archive}`)

  const builderRequire = createRequire(require.resolve('electron-builder/package.json'))
  const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'))
  const { downloadArtifact } = await import(pathToFileURL(appBuilderRequire.resolve('@electron/get')).href)
  const path = await downloadArtifact({
    version,
    platform: process.platform,
    arch: process.arch,
    artifactName: 'electron',
    cacheRoot,
    checksums: { [archive]: checksum },
    downloader: {
      async download(_url, destination) {
        const content = await downloadGithubReleaseAsset(`https://github.com/electron/electron/releases/download/v${version}`, archive, { timeoutMs: 300_000 })
        writeFileSync(destination, content)
      },
    },
  })
  return { version, path }
}

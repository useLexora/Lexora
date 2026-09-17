import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { writeError } from '../../shared/cli-output.mjs'
import { prepareNativeHost } from './native-host.mjs'
import { prepareSearchTools } from './search-tools.mjs'
import { prepareShellSandbox } from './shell-sandbox.mjs'
import { resolveBuildTarget } from './targets.mjs'

const platform = resolveBuildTarget()
const release = process.argv.includes('--release')
const builders = {
  nativePet() {
    const result = spawnSync('cargo', [
      'build',
      '--locked',
      ...(release ? ['--release'] : []),
      '--target-dir',
      '.output/build/native',
      '--manifest-path',
      'native/Cargo.toml',
      '--package',
      'lexora-buddy-pet',
      '--bin',
      'lexora-buddy-pet',
    ], { cwd: new URL('../../../apps/buddy/', import.meta.url), stdio: 'inherit' })
    if (result.error)
      throw result.error
    if (result.status !== 0)
      throw new Error(`Native pet build failed: ${result.status ?? result.signal}`)
  },
}

void Promise.all([prepareSearchTools(), prepareShellSandbox()]).then(() => {
  prepareNativeHost()
  for (const feature of platform.features)
    builders[feature]?.()
}).catch((error) => {
  writeError(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

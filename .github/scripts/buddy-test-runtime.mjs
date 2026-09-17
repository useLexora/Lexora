import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import shellSandbox from '../../apps/buddy/platform/native/shellSandbox.json' with { type: 'json' }
import { nativeHostResources, prepareNativeHost } from '../../packaging/buddy/release/native-host.mjs'
import { prepareShellSandbox } from '../../packaging/buddy/release/shell-sandbox.mjs'
import { resolveBuildTarget } from '../../packaging/buddy/release/targets.mjs'

const archive = process.argv[2]
if (!archive || process.argv.length !== 3)
  throw new Error('Usage: buddy-test-runtime.mjs <archive>')

const target = resolveBuildTarget()
prepareNativeHost(target)
await prepareShellSandbox()
execFileSync('tar', [
  '-cf',
  resolve(archive),
  '-C',
  fileURLToPath(new URL('../../apps/buddy/', import.meta.url)),
  ...nativeHostResources(target).map(resource => resource.from),
  ...(process.platform === 'linux' ? [`${shellSandbox.resource.from}/${target.id}`] : []),
], { stdio: 'inherit' })

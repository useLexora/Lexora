import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import sandbox from '../../../apps/buddy/platform/native/shellSandbox.json' with { type: 'json' }
import { OPERATING_SYSTEM } from '../../../apps/buddy/shared/platform/identifiers.ts'
import { writeError, writeOutput } from '../../shared/cli-output.mjs'
import { assertNativeExecutable } from './native-host.mjs'
import { resolveBuddyOutputPaths } from './output-paths.mjs'
import { requireNativeBuildTarget, resolveBuildTarget } from './targets.mjs'

const repoRoot = resolve(import.meta.dirname, '../../..')

export function verifyShellSandboxFiles(readEntry, target) {
  assertNativeExecutable(readEntry('bwrap'), target, 'shell sandbox')
  if (createHash('sha256').update(readEntry(sandbox.archive)).digest('hex') !== sandbox.sha256)
    throw new Error('Shell sandbox source checksum mismatch')
  if (!readEntry('COPYING').length)
    throw new Error('Shell sandbox license is missing')
}

export async function prepareShellSandbox({ cwd = repoRoot, platformId = process.platform, architecture = process.arch } = {}) {
  if (platformId !== OPERATING_SYSTEM.Linux)
    return
  const target = resolveBuildTarget(`${platformId}-${architecture}`)
  requireNativeBuildTarget(target)
  const paths = resolveBuddyOutputPaths(cwd)
  const output = join(paths.buddyRoot, sandbox.resource.from, target.id)
  const verify = (directory) => {
    verifyShellSandboxFiles(entry => readFileSync(join(directory, entry)), target)
    const binary = join(directory, 'bwrap')
    if ((statSync(binary).mode & 0o6000) !== 0)
      throw new Error('Shell sandbox must not be setuid or setgid')
    if (execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 5_000 }).trim() !== `bubblewrap ${sandbox.version}`)
      throw new Error('Shell sandbox version mismatch')
  }
  if (existsSync(output)) {
    verify(output)
    return output
  }
  mkdirSync(dirname(output), { recursive: true })
  const staging = mkdtempSync(join(dirname(output), 'prepare-'))
  try {
    writeOutput(`Preparing bubblewrap ${sandbox.version}`)
    const response = await fetch(`${sandbox.release}/${sandbox.archive}`, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok)
      throw new Error(`Unable to download bubblewrap: HTTP ${response.status}`)
    const content = Buffer.from(await response.arrayBuffer())
    if (createHash('sha256').update(content).digest('hex') !== sandbox.sha256)
      throw new Error('Shell sandbox download checksum mismatch')
    const archive = join(staging, sandbox.archive)
    writeFileSync(archive, content)
    execFileSync('tar', ['-xf', archive, '-C', staging], { timeout: 30_000 })
    const source = join(staging, `bubblewrap-${sandbox.version}`)
    const build = join(staging, 'build')
    execFileSync('meson', ['setup', build, source, '--buildtype=release', '-Dman=disabled', '-Dtests=false', '-Dselinux=disabled', '-Dassume_kernel=5.6.0'], { stdio: 'inherit', timeout: 60_000 })
    execFileSync('meson', ['compile', '-C', build], { stdio: 'inherit', timeout: 60_000 })
    copyFileSync(join(build, 'bwrap'), join(staging, 'bwrap'))
    chmodSync(join(staging, 'bwrap'), 0o755)
    copyFileSync(join(source, 'COPYING'), join(staging, 'COPYING'))
    verify(staging)
    rmSync(source, { recursive: true })
    rmSync(build, { recursive: true })
    renameSync(staging, output)
    return output
  }
  finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void prepareShellSandbox().then(writeOutput).catch((error) => {
    writeError(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

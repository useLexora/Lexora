import { spawnSync } from 'node:child_process'
import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { CPU_ARCHITECTURE } from '../../../apps/buddy/shared/platform/identifiers.ts'
import { writeOutput } from '../../shared/cli-output.mjs'
import { desktopArtifact } from './artifacts.mjs'
import { notarizeMacosArtifact, requireMacosSigningEnvironment } from './macos.mjs'
import { resolveBuddyOutputPaths } from './output-paths.mjs'
import { requireNativeBuildTarget, requirePackageFormat, resolveBuildTarget } from './targets.mjs'
import { verifyElectronBundle } from './verify-electron-bundle.mjs'
import { verifyDesktopDirectory, verifyLinuxPackage } from './verify-package.mjs'

const repoRoot = resolve(import.meta.dirname, '../../..')
const { values } = parseArgs({ options: { target: { type: 'string' }, format: { type: 'string' } } })
const target = values.format
if (!target)
  throw new Error('Usage: package-desktop.mjs --format deb|pacman|nsis|dmg [--target <os-architecture>]')
const platform = resolveBuildTarget(values.target)
requireNativeBuildTarget(platform)
requirePackageFormat(platform, target)
if (target === 'dmg')
  requireMacosSigningEnvironment()

const errors = verifyElectronBundle()
if (errors.length)
  throw new Error(errors.join('\n'))
const paths = resolveBuddyOutputPaths(repoRoot)
const artifact = desktopArtifact(platform, target, { cwd: repoRoot })
const artifactDirectory = paths.artifacts[artifact.directory]
rmSync(paths.package.desktop, { force: true, recursive: true })
rmSync(artifact.path, { force: true })
mkdirSync(artifactDirectory, { recursive: true })

const require = createRequire(join(paths.buddyRoot, 'package.json'))
const result = spawnSync(process.execPath, [
  require.resolve('electron-builder/cli.js'),
  '--config',
  'electron-builder.config.cjs',
  `--${platform.builderPlatform}`,
  target,
  `--${platform.architecture}`,
  '--publish',
  'never',
], { cwd: paths.buddyRoot, env: process.env, stdio: 'inherit' })
if (result.error)
  throw result.error
if (result.status !== 0)
  throw new Error(`electron-builder failed: ${result.status ?? result.signal}`)

const packagePath = join(paths.package.desktop, artifact.name)
if (target === 'dmg')
  notarizeMacosArtifact(packagePath)
if (target === 'nsis')
  verifyDesktopDirectory(join(paths.package.desktop, platform.architecture === CPU_ARCHITECTURE.X64 ? 'win-unpacked' : `win-${platform.architecture}-unpacked`), platform.id)
else if (target === 'dmg')
  verifyDesktopDirectory(join(paths.package.desktop, `mac-${platform.architecture}/lexora-buddy.app`), platform.id)
else
  verifyLinuxPackage(target, packagePath, repoRoot, platform.id)
renameSync(packagePath, artifact.path)
writeOutput(artifact.path)

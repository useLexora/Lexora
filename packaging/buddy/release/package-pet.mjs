import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { CPU_ARCHITECTURE, OPERATING_SYSTEM } from '../../../apps/buddy/shared/platform/identifiers.ts'

import { writeOutput } from '../../shared/cli-output.mjs'
import { assertNativeExecutable } from './native-host.mjs'
import { resolveBuddyOutputPaths } from './output-paths.mjs'
import { resolveBuildTarget } from './targets.mjs'

const repoRoot = resolve(import.meta.dirname, '../../..')
const paths = resolveBuddyOutputPaths(repoRoot)
const buddyRoot = paths.buddyRoot
const version = JSON.parse(
  readFileSync(join(buddyRoot, 'buddy.version.json'), 'utf8'),
).version
const packageName = `Lexora-Buddy-Pet-${version}-linux-${resolveBuildTarget().architecture === CPU_ARCHITECTURE.X64 ? 'x86_64' : 'aarch64'}`
const outputRoot = paths.artifacts.pet
const stagingRoot = paths.package.pet
const packageRoot = join(stagingRoot, packageName)
const petSource = join(paths.build.native, 'release/lexora-buddy-pet')
const petTarget = join(packageRoot, 'bin/lexora-buddy-pet')

if (resolveBuildTarget().platform !== OPERATING_SYSTEM.Linux)
  throw new Error('Lexora Buddy standalone pet packaging requires Linux')

rmSync(stagingRoot, { force: true, recursive: true })
rmSync(outputRoot, { force: true, recursive: true })
assertNativeExecutable(readFileSync(petSource), resolveBuildTarget(), petSource)
mkdirSync(join(packageRoot, 'bin'), { recursive: true })
mkdirSync(join(packageRoot, 'share/applications'), { recursive: true })
mkdirSync(join(packageRoot, 'share/icons/hicolor/512x512/apps'), { recursive: true })

cpSync(petSource, petTarget)
chmodSync(petTarget, 0o755)
cpSync(
  join(buddyRoot, 'resources/icons/app-icon.png'),
  join(packageRoot, 'share/icons/hicolor/512x512/apps/lexora-buddy.png'),
)
writeFileSync(
  join(packageRoot, 'share/applications/lexora-buddy.desktop'),
  [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Lexora Buddy',
    'Comment=Lexora desktop pet',
    'Exec=lexora-buddy-pet --native-pet',
    'Icon=lexora-buddy',
    'Terminal=false',
    'Categories=Utility;',
    '',
  ].join('\n'),
)
writeFileSync(
  join(packageRoot, 'README.txt'),
  [
    'Lexora Buddy standalone pet',
    '',
    'Copy bin/lexora-buddy-pet into PATH, then run:',
    '  lexora-buddy-pet --native-pet',
    '',
    'This package contains only the native pet. It does not include Buddy Desktop or its Buddy Local Service.',
    '',
  ].join('\n'),
)

mkdirSync(outputRoot, { recursive: true })
const archivePath = join(outputRoot, `${packageName}.tar.gz`)
const result = spawnSync('tar', [
  '-czf',
  archivePath,
  '-C',
  stagingRoot,
  basename(packageRoot),
], { stdio: 'inherit' })
if (result.status !== 0)
  throw new Error(`tar failed with exit code ${result.status ?? 'unknown'}`)

writeOutput(archivePath)

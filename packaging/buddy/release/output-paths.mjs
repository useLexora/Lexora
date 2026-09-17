import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../../..')

export function resolveBuddyOutputPaths(cwd = repoRoot) {
  const buddyRoot = join(cwd, 'apps/buddy')
  const outputRoot = join(buddyRoot, '.output')

  return {
    artifacts: {
      arch: join(outputRoot, 'artifacts/arch'),
      desktop: join(outputRoot, 'artifacts/desktop'),
      pet: join(outputRoot, 'artifacts/pet'),
      windows: join(outputRoot, 'artifacts/windows'),
      macos: join(outputRoot, 'artifacts/macos'),
    },
    buddyRoot,
    build: {
      electron: join(outputRoot, 'build/electron'),
      native: join(outputRoot, 'build/native'),
    },
    outputRoot,
    package: {
      desktop: join(outputRoot, 'package/desktop'),
      pet: join(outputRoot, 'package/pet'),
    },
  }
}

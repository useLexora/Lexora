import process from 'node:process'
import { containsCanonicalPath, filePaths } from '../../../platform/filesystem/filePaths'
import { resolveSensitiveLocations } from '../../../platform/filesystem/sensitiveLocations'
import { resolveUserHomePaths } from '../../../platform/filesystem/userHomePaths'

const HOME_RELATIVE_ROOTS = [
  '.aws',
  '.claude/.credentials.json',
  '.codex/auth.json',
  '.docker/config.json',
  '.gnupg',
  '.kube',
  '.mozilla',
  '.netrc',
  '.npmrc',
  '.pgpass',
  '.pi/agent/auth.json',
  '.ssh',
  '_netrc',
]

export interface SensitivePathMatcher {
  matches: (canonicalPath: string) => boolean
}

export interface CreateSensitivePathMatcherOptions {
  additionalRoots?: readonly string[]
  environment?: NodeJS.ProcessEnv
  home?: string
}

export function createSensitivePathMatcher(
  options: CreateSensitivePathMatcherOptions = {},
): SensitivePathMatcher {
  const sensitiveRoots = resolveSensitivePathRoots(options).map(filePaths.sensitiveKey)

  return {
    matches(canonicalPath: string): boolean {
      let path: string
      try {
        path = filePaths.resolveInput(canonicalPath)
      }
      catch {
        return false
      }
      return sensitiveRoots.some(root => containsCanonicalPath(root, filePaths.sensitiveKey(path)))
    },
  }
}

export function resolveSensitivePathRoots(options: CreateSensitivePathMatcherOptions = {}): string[] {
  const environment = options.environment ?? process.env
  const homes = resolveUserHomePaths(environment, options.home)
  const roots = new Set<string>()

  for (const home of homes) {
    for (const relative of HOME_RELATIVE_ROOTS)
      roots.add(filePaths.resolveInput(relative, home))
  }
  const locations = (homes.length ? homes : [null]).flatMap(home => resolveSensitiveLocations(home, environment))
  for (const root of [...locations, ...(options.additionalRoots ?? [])]) {
    try {
      roots.add(filePaths.resolveInput(root))
    }
    catch {
      continue
    }
  }

  return [...roots]
}

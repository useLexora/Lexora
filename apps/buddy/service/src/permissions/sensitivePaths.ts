import { homedir } from 'node:os'
import process from 'node:process'
import { containsCanonicalPath, filePaths } from '../../../platform/filesystem/filePaths'
import { resolveSensitiveLocations } from '../../../platform/filesystem/sensitiveLocations'

const HOME_RELATIVE_ROOTS = [
  '.aws',
  '.claude',
  '.codex',
  '.docker',
  '.gnupg',
  '.kube',
  '.mozilla',
  '.npmrc',
  '.pgpass',
  '.pi',
  '.ssh',
]

const SENSITIVE_BASENAME_PATTERN
  = /^(?:\.env(?:\..+)?|\.netrc|_netrc|\.pgpass|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.pem|.*\.p12|.*\.pfx)$/i

const SECRET_TEMPLATE_BASENAME_PATTERN
  = /^\.env(?:\..+)?\.(?:example|sample|template|defaults?|dist|schema)$/i

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
      const name = filePaths.path.basename(path)
      if (SENSITIVE_BASENAME_PATTERN.test(name) && !SECRET_TEMPLATE_BASENAME_PATTERN.test(name))
        return true
      return sensitiveRoots.some(root => containsCanonicalPath(root, filePaths.sensitiveKey(path)))
    },
  }
}

export function resolveSensitivePathRoots(options: CreateSensitivePathMatcherOptions = {}): string[] {
  const home = options.home ?? safeHomedir()
  const environment = options.environment ?? process.env
  const roots = new Set<string>()

  for (const relative of HOME_RELATIVE_ROOTS) {
    if (home)
      roots.add(filePaths.resolveInput(relative, home))
  }
  for (const root of [...resolveSensitiveLocations(home, environment), ...(options.additionalRoots ?? [])]) {
    try {
      roots.add(filePaths.resolveInput(root))
    }
    catch {
      continue
    }
  }

  return [...roots]
}

function safeHomedir(): string | null {
  try {
    const home = homedir()
    return home ? filePaths.resolveInput(home) : null
  }
  catch {
    return null
  }
}

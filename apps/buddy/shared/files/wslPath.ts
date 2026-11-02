export interface WslPath {
  distribution: string
  linuxPath: string
}

const PREFIXES = ['\\\\wsl.localhost\\', '\\\\wsl$\\']

// `\\wsl.localhost\<distribution>\home\user` (or `\\wsl$\...`) as the distribution and its Linux path; null for any other path.
export function parseWslPath(path: string): WslPath | null {
  const normalized = path.replaceAll('/', '\\')
  const prefix = PREFIXES.find(candidate => normalized.toLowerCase().startsWith(candidate))
  if (!prefix)
    return null
  const [distribution, ...segments] = normalized.slice(prefix.length).split('\\')
  if (!distribution)
    return null
  return { distribution, linuxPath: `/${segments.filter(Boolean).join('/')}` }
}

import { userInfo } from 'node:os'
import process from 'node:process'
import { currentPlatform } from '../currentPlatform'
import { filePaths } from './filePaths'

export function resolveUserHomePaths(environment: NodeJS.ProcessEnv = process.env, home: string = userInfo().homedir): string[] {
  const windows = currentPlatform.id === 'win32'
  const inherited = Object.fromEntries(Object.entries(environment).map(([name, value]) => [windows ? name.toUpperCase() : name, value]))
  const candidates = [home, inherited.HOME]
  if (windows) {
    candidates.push(inherited.USERPROFILE)
    if (inherited.HOMEDRIVE && inherited.HOMEPATH)
      candidates.push(`${inherited.HOMEDRIVE}${inherited.HOMEPATH}`)
  }
  const roots = new Map<string, string>()
  for (const candidate of candidates) {
    if (!candidate || !filePaths.path.isAbsolute(candidate))
      continue
    try {
      const root = filePaths.resolveInput(candidate)
      roots.set(filePaths.sensitiveKey(root), root)
    }
    catch {}
  }
  return [...roots.values()]
}

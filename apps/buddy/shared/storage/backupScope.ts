import { z } from 'zod'

export const backupScopeSchema = z.enum(['tasks', 'workspaces', 'buddies', 'providers', 'connections', 'skills', 'plugins', 'automations', 'settings'])
export type BackupScope = z.infer<typeof backupScopeSchema>
export const backupScopes = backupScopeSchema.options
export const backupSelectionSchema = z.array(backupScopeSchema).min(1).refine(items => new Set(items).size === items.length)
export const backupRequestSchema = z.object({ scopes: backupSelectionSchema, password: z.string().min(8).max(1024).optional(), credentials: z.boolean().default(false) }).strict()
export const backupOptionsSchema = backupRequestSchema.refine(value => !value.credentials || !!value.password)
export type BackupOptions = z.infer<typeof backupOptionsSchema>

export function backupPathScope(path: string): BackupScope | null {
  if (path === 'config.toml' || /^buddy\/themes\/(?:user-themes\.json|assets\/[a-f0-9]{64})$/.test(path))
    return 'settings'
  if (path === 'device/sync.json')
    return 'connections'
  if (/^buddy\/extensions\/(?:installed\.json|schedules\.json|packages\/.+|data\/[^/]+\/(?:(?:configuration|state|owned-resources)\.json|files\/[a-f0-9]{64}))$/.test(path))
    return 'plugins'
  if (/^buddy\/(?:skills|agent\/skills|spaces\/[^/]+\/skills)(?:\/|$)/.test(path))
    return 'skills'
  if (/^buddy\/(?:conversations|spaces)\/[^/]+\/workspace(?:\/|$)/.test(path))
    return 'workspaces'
  if (/^buddy\/(?:conversations|drafts|spaces)(?:\/|$)/.test(path))
    return 'tasks'
  return null
}
export function backupPathAllowed(path: string, scopes: readonly BackupScope[]): boolean {
  if (path === 'buddy/buddy.sqlite3' || path === 'credentials.enc')
    return true
  const scope = backupPathScope(path)
  return scope !== null && scopes.includes(scope)
}
export function backupDirectoryAllowed(path: string, scopes: readonly BackupScope[]): boolean {
  return backupPathAllowed(path, scopes) || path === 'buddy'
    || (scopes.includes('settings') && /^buddy\/themes(?:\/assets)?$/.test(path))
    || (scopes.includes('connections') && path === 'device')
    || (scopes.includes('skills') && (path === 'buddy/agent' || /^buddy\/spaces(?:\/[^/]+)?$/.test(path)))
    || (scopes.includes('workspaces') && /^buddy\/(?:conversations|spaces)(?:\/[^/]+)?$/.test(path))
    || (scopes.includes('plugins') && /^buddy\/extensions(?:\/(?:data|packages)(?:\/[^/]+(?:\/files)?)?)?$/.test(path))
}

import { z } from 'zod'

export const workbenchSlashSchema = z.object({ name: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/), description: z.string().max(200).optional() }).strict()
export function qualifyWorkbenchCommand(namespace: string, name: string): string {
  return `${namespace}:${name}`
}

export interface WorkbenchCommandOrigin { id: string, name: string, author?: string, version: string, source?: string }
export interface WorkbenchSlashCommand { id: string, name: string, title: string, description?: string, origin?: WorkbenchCommandOrigin }
export function parseSlashInvocation(value: string): { name: string, arguments: string } | null {
  const match = /^\/(\S+)(?:\s([\s\S]*))?$/u.exec(value.trim())
  return match ? { name: match[1]!, arguments: match[2]?.trimStart() ?? '' } : null
}

import { AgentTimeZoneSchema } from '@haohaoxue/lexora-contracts/agent'

export function resolveBrowserTimeZone(): string | null {
  if (typeof Intl === 'undefined') {
    return null
  }

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const result = AgentTimeZoneSchema.nullable().safeParse(timeZone ?? null)
  return result.success ? result.data : null
}

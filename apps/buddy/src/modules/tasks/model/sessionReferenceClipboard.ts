import type { BuddySessionReference } from '@buddy-shared/conversation/buddyUserContent'
import { BUDDY_SESSION_REFERENCE_TITLE_LIMIT, buddySessionReferenceSchema } from '@buddy-shared/conversation/buddyUserContent'

const PREFIX = 'LEXORA_SESSION_REF_V1:'

export function formatSessionReferenceClipboard(reference: BuddySessionReference): string {
  return `${PREFIX}${encodeURIComponent(JSON.stringify({ id: reference.id, title: reference.title }))}`
}

export function parseSessionReferenceClipboard(value: string): { references: BuddySessionReference[], text: string } | null {
  const lines = value.split(/\r?\n/u)
  const references: BuddySessionReference[] = []
  const text: string[] = []
  for (const line of lines) {
    if (!line.startsWith(PREFIX)) {
      text.push(line)
      continue
    }
    try {
      const raw = JSON.parse(decodeURIComponent(line.slice(PREFIX.length))) as Record<string, unknown>
      if (typeof raw.id === 'string')
        raw.id = raw.id.trim()
      if (typeof raw.title === 'string')
        raw.title = raw.title.replace(/[\r\n]+/gu, ' ').trim().slice(0, BUDDY_SESSION_REFERENCE_TITLE_LIMIT)
      const parsed = buddySessionReferenceSchema.safeParse(raw)
      if (!parsed.success)
        return null
      references.push(parsed.data)
    }
    catch {
      return null
    }
  }
  return references.length ? { references, text: text.join('\n') } : null
}

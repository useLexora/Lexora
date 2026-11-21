export const MAX_BUDDY_MESSAGE_TEXT_LENGTH = 2 * 1024 * 1024

export interface BuddyInterruptedMessageContent {
  state: 'interrupted'
  text: string
  truncated: boolean
}

export function createBuddyInterruptedMessageContent(
  text: string,
  truncated: boolean,
): BuddyInterruptedMessageContent {
  const incomplete = truncated || text.length > MAX_BUDDY_MESSAGE_TEXT_LENGTH
  const prefix = text.slice(0, MAX_BUDDY_MESSAGE_TEXT_LENGTH)
  return {
    state: 'interrupted',
    text: incomplete ? prefix.replace(/[\uD800-\uDBFF]$/, '') : prefix,
    truncated: incomplete,
  }
}

export function readBuddyInterruptedMessageContent(
  value: unknown,
): BuddyInterruptedMessageContent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return null
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== 3
    || record.state !== 'interrupted'
    || typeof record.text !== 'string'
    || record.text.length > MAX_BUDDY_MESSAGE_TEXT_LENGTH
    || typeof record.truncated !== 'boolean'
  ) {
    return null
  }
  return {
    state: 'interrupted',
    text: record.text,
    truncated: record.truncated,
  }
}

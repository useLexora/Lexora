import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { readBuddyInputReference } from '../agent/context/BuddyInputReference'

export function imageReadingRequest(context: Pick<ExtensionContext, 'sessionManager'>): string {
  const entry = context.sessionManager?.getBranch().findLast(entry => entry.type === 'message' && entry.message.role === 'user')
  if (entry?.type !== 'message' || entry.message.role !== 'user')
    return ''
  const reference = readBuddyInputReference(entry.message)
  const request = reference?.prompt ?? (typeof entry.message.content === 'string'
    ? entry.message.content
    : entry.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
  return request.length <= 32768 ? request : `${request.slice(0, 32768)}\n[The remainder of the user request is omitted; use the focused visual question for this inspection.]`
}

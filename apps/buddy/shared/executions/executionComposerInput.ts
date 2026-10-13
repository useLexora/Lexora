import type { BuddyUserContentV1 } from '../conversation/buddyUserContent'

export function isExecutionTextInput(content: BuddyUserContentV1): boolean {
  return !content.panelResourceIds.length && !content.quotes?.length && !content.sessionReferences?.length
    && content.body.every(paragraph => paragraph.content.every(node => node.type === 'text' || node.type === 'actor_ref'))
}

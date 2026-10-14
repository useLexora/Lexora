import type { BuddyPromptDirective, BuddyUserContentV1 } from './buddyUserContent'
import { buddyPromptDirectiveToText } from './buddyUserContent'

export function escapeLiteralMarkers(text: string): string {
  return text.replace(/\[(?:(IMAGE|FILE|LOCAL)#(\d+)|Image #(\d+)|SESSION:[\w-]+)\]/g, match => `［${match.slice(1, -1)}］`)
}

export function projectBuddyUserText(
  content: BuddyUserContentV1,
  resolveResource: (id: string) => string = () => '@file',
  resolveDirective: (directive: BuddyPromptDirective) => string = buddyPromptDirectiveToText,
): string {
  return content.body.map((paragraph) => {
    let literal = ''
    let projected = ''
    for (const node of paragraph.content) {
      switch (node.type) {
        case 'text':
          literal += node.text
          break
        case 'hard_break':
          literal += '\n'
          break
        case 'actor_ref':
          literal += `@${node.name}`
          break
        case 'prompt_directive': {
          literal += resolveDirective(node)
          break
        }
        case 'resource_ref':
        case 'session_ref': {
          projected += escapeLiteralMarkers(literal) + (node.type === 'session_ref' ? `[SESSION:${node.sessionId}]` : resolveResource(node.resourceId))
          literal = ''
          break
        }
      }
    }
    return projected + escapeLiteralMarkers(literal)
  }).join('\n')
}

export function sessionReferenceText(content: BuddyUserContentV1): string {
  return content.sessionReferences?.length
    ? `Referenced tasks: ${JSON.stringify(content.sessionReferences.map(reference => ({ ...reference, title: escapeLiteralMarkers(reference.title) })))}`
    : ''
}

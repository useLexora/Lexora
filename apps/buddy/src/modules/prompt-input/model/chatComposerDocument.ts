import type { BuddyInlineNodeV1, BuddyUserContentV1 } from '@buddy-shared/conversation/buddyUserContent'
import type { JSONContent } from '@tiptap/core'
import { isRetiredBuddyPromptCommand } from '@buddy-shared/conversation/buddyChatCommands'
import { buddyUserContentV1Schema } from '@buddy-shared/conversation/buddyUserContent'

export const CHAT_RESOURCE_REFERENCE_NODE_NAME = 'chatResourceReference'
export const CHAT_PROMPT_DIRECTIVE_NODE_NAME = 'chatPromptDirective'

export function userContentToChatComposerDocument(content: BuddyUserContentV1): JSONContent {
  return {
    attrs: { panelResourceIds: [...content.panelResourceIds], ...(content.quotes?.length ? { quotes: content.quotes } : {}) },
    content: content.body.map(paragraph => ({
      content: paragraph.content.map(inlineNodeToEditorNode),
      type: 'paragraph',
    })),
    type: 'doc',
  }
}

export function chatComposerDocumentToUserContent(document: JSONContent): BuddyUserContentV1 {
  if (document.type !== 'doc')
    throw new Error('Invalid Composer document')

  return buddyUserContentV1Schema.parse({
    body: document.content?.map((paragraph) => {
      if (paragraph.type !== 'paragraph')
        throw new Error(`Unsupported Composer paragraph: ${paragraph.type}`)
      return {
        content: (paragraph.content ?? []).map(editorNodeToInlineNode),
        type: 'paragraph',
      }
    }),
    panelResourceIds: document.attrs?.panelResourceIds ?? [],
    ...(document.attrs?.quotes?.length ? { quotes: document.attrs.quotes } : {}),
    version: 1,
  })
}

function inlineNodeToEditorNode(node: BuddyInlineNodeV1): JSONContent {
  switch (node.type) {
    case 'text': return { text: node.text, type: 'text' }
    case 'hard_break': return { type: 'hardBreak' }
    case 'resource_ref': return {
      attrs: { resourceId: node.resourceId },
      type: CHAT_RESOURCE_REFERENCE_NODE_NAME,
    }
    case 'prompt_directive': return node.directive === 'slash_command' && !node.commandId && isRetiredBuddyPromptCommand(node.value)
      ? { text: node.value, type: 'text' }
      : {
          attrs: node.directive === 'skill'
            ? { directive: node.directive, value: node.value, ...(node.skill ? { skill: { ...node.skill } } : {}) }
            : { commandMode: node.commandMode, ...(node.commandId ? { commandId: node.commandId } : {}), directive: node.directive, value: node.value },
          type: CHAT_PROMPT_DIRECTIVE_NODE_NAME,
        }
  }
}

function editorNodeToInlineNode(node: JSONContent): unknown {
  if (node.marks?.length)
    throw new Error('Formatting is not part of Composer content')

  switch (node.type) {
    case 'text': return { text: node.text, type: 'text' }
    case 'hardBreak': return { type: 'hard_break' }
    case CHAT_RESOURCE_REFERENCE_NODE_NAME: return {
      resourceId: node.attrs?.resourceId,
      type: 'resource_ref',
    }
    case CHAT_PROMPT_DIRECTIVE_NODE_NAME: {
      const attrs = node.attrs ?? {}
      if (attrs.directive === 'skill' && attrs.commandMode != null)
        throw new Error('Skill directives cannot have a command mode')
      return {
        ...(attrs.directive === 'skill' ? (attrs.skill ? { skill: attrs.skill } : {}) : { commandMode: attrs.commandMode, ...(attrs.commandId ? { commandId: attrs.commandId } : {}) }),
        directive: attrs.directive,
        type: 'prompt_directive',
        value: attrs.value,
      }
    }
    default: throw new Error(`Unsupported Composer inline node: ${node.type}`)
  }
}

import type { BuddyActorReference } from '@buddy-shared/conversation/buddyUserContent'
import type { Editor } from '@tiptap/core'
import { buddyActorReferenceSchema } from '@buddy-shared/conversation/buddyUserContent'
import { Node } from '@tiptap/core'
import { CHAT_ACTOR_REFERENCE_NODE_NAME } from '../model/chatComposerDocument'
import { dispatchComposerEdit } from './chatComposerResourceEditing'

export const ChatComposerActorReference = Node.create({
  name: CHAT_ACTOR_REFERENCE_NODE_NAME,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({ actorId: { default: null, rendered: false }, name: { default: '', rendered: false } }),
  renderHTML: ({ node }) => ['span', { 'class': 'chat-prompt-token-node', 'data-type': 'chat-actor-reference', 'contenteditable': 'false' }, `@${node.attrs.name}`],
  renderText: ({ node }) => `@${node.attrs.name}`,
})

export function insertChatComposerActorReference(editor: Editor, value: BuddyActorReference, range?: { from: number, to: number }): boolean {
  if (editor.isDestroyed || !editor.isEditable)
    return false
  const reference = buddyActorReferenceSchema.parse(value)
  const { from, to } = range ?? editor.state.selection
  return dispatchComposerEdit(editor, editor.state.tr.replaceWith(from, to, [
    editor.schema.nodes[CHAT_ACTOR_REFERENCE_NODE_NAME]!.create({ actorId: reference.actorId, name: reference.name }),
    editor.schema.text(' '),
  ]))
}

// @vitest-environment jsdom

import type { Editor } from '@tiptap/core'
import { buddyUserContentV1Schema, createBuddyUserContent, getBuddyUserContentActorReferences } from '@buddy-shared/conversation/buddyUserContent'
import { Editor as TiptapEditor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatComposerActorReference, insertChatComposerActorReference } from '../../editor/chatComposerActorEditing'
import {
  ChatComposerDocument,
  ChatComposerPromptDirective,
  ChatComposerResourceReference,
  insertChatComposerResources,
  insertResolvedChatComposerResource,
  replaceChatComposerDocument,
} from '../../editor/chatComposerResourceEditing'
import { ChatComposerSessionReference, insertChatComposerSessionReferences, removeChatComposerSessionReference } from '../../editor/chatComposerSessionEditing'
import {
  chatComposerDocumentToUserContent,
  userContentToChatComposerDocument,
} from '../chatComposerDocument'

const editors: Editor[] = []

afterEach(() => {
  for (const editor of editors.splice(0))
    editor.destroy()
})

describe('composer product document boundary', () => {
  it('round-trips the full versioned body and panel through a real editor schema', () => {
    const content = buddyUserContentV1Schema.parse({
      body: [{
        content: [
          { text: '比较 ', type: 'text' },
          { type: 'resource_ref', resourceId: 'image-a' },
          { type: 'hard_break' },
          { type: 'resource_ref', resourceId: 'image-a' },
          { directive: 'skill', type: 'prompt_directive', value: 'review', skill: { id: 'review-id', name: 'review', revision: 'revision-one' } },
          { commandMode: 'prompt', directive: 'slash_command', type: 'prompt_directive', value: '/review' },
          { actorId: 'reviewer', name: '审查伙伴', type: 'actor_ref' },
        ],
        type: 'paragraph',
      }, { type: 'paragraph', content: [] }],
      panelResourceIds: ['image-b', 'image-a'],
      version: 1,
    })
    const editor = createEditor()
    replaceChatComposerDocument(editor, content)

    expect(chatComposerDocumentToUserContent(editor.getJSON())).toEqual(content)
    expect(editor.getText()).toContain('@image-a.png')
    expect(editor.getHTML()).not.toContain('resourceid=')
  })

  it.each(['/plan', '/status', '/skills'])('downgrades the retired %s prompt directive to plain text instead of blocking the draft', (command) => {
    const content = buddyUserContentV1Schema.parse({
      body: [{
        content: [
          { commandMode: 'prompt', directive: 'slash_command', type: 'prompt_directive', value: command },
          { text: ' 继续', type: 'text' },
        ],
        type: 'paragraph',
      }],
      panelResourceIds: [],
      version: 1,
    })
    const editor = createEditor()
    replaceChatComposerDocument(editor, content)

    expect(editor.getJSON().content?.[0]?.content?.[0]).toEqual({ text: `${command} 继续`, type: 'text' })
    expect(editor.getText()).toBe(`${command} 继续`)
    expect(chatComposerDocumentToUserContent(editor.getJSON()).body[0]?.content).toEqual([
      { text: `${command} 继续`, type: 'text' },
    ])
  })

  it('rejects unknown editor nodes and formatting instead of silently losing content', () => {
    for (const node of [
      { type: 'image', attrs: { src: 'file:///private' } },
      { type: 'chatPromptToken', attrs: { kind: 'file', value: 'notes.md' } },
      { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
      { type: 'chatResourceReference', attrs: { resourceId: '../private' } },
      { type: 'chatPromptDirective', attrs: { directive: 'unknown', value: 'review' } },
    ]) {
      expect(() => chatComposerDocumentToUserContent({
        type: 'doc',
        attrs: { panelResourceIds: [] },
        content: [{ type: 'paragraph', content: [node] }],
      })).toThrow()
    }
  })

  it('does not grant resource identity to pasted external HTML', () => {
    const editor = createEditor()
    editor.commands.insertContent('<p><span data-type="chat-resource-reference" resourceid="private-id">@photo.png</span></p>')
    expect(chatComposerDocumentToUserContent(editor.getJSON())).toEqual(createBuddyUserContent('@photo.png'))
  })
})

describe('composer body and panel edit history', () => {
  it('maps an asynchronous file selection to its original trigger without moving the current caret', async () => {
    const editor = createEditor()
    editor.commands.insertContent('compare @note later')
    let resolve!: (id: string) => void
    const pending = insertResolvedChatComposerResource(editor, { from: 9, to: 14 }, () => new Promise<string>(done => resolve = done))
    editor.commands.insertContentAt(1, 'First ')
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    const before = editor.getJSON()
    resolve('notes')
    expect(await pending).toBe(true)
    expect(editor.getText()).toBe('First compare @notes.png  later')
    expect(editor.state.selection.from).toBe(editor.state.doc.content.size - 1)
    editor.commands.undo()
    expect(editor.getJSON()).toEqual(before)
    editor.commands.redo()
    expect(chatComposerDocumentToUserContent(editor.getJSON()).body[0]!.content.filter(node => node.type === 'resource_ref')).toEqual([{ type: 'resource_ref', resourceId: 'notes' }])
    expect(chatComposerDocumentToUserContent(editor.getJSON()).panelResourceIds).toEqual([])
  })

  it('does not resurrect a replaced trigger when file selection finishes', async () => {
    const editor = createEditor()
    editor.commands.insertContent('@note')
    let resolve!: (id: string) => void
    const pending = insertResolvedChatComposerResource(editor, { from: 1, to: 6 }, () => new Promise<string>(done => resolve = done))
    editor.chain().selectAll().deleteSelection().run()
    editor.commands.insertContent('different input')
    resolve('notes')
    expect(await pending).toBe(false)
    expect(editor.getText()).toBe('different input')
  })

  it('keeps panel-only additions out of the body and does not duplicate their IDs', () => {
    const editor = createEditor()
    insertChatComposerResources(editor, ['notes'], 'panel')
    insertChatComposerResources(editor, ['notes'], 'panel')
    expect(chatComposerDocumentToUserContent(editor.getJSON())).toEqual({
      ...createBuddyUserContent(),
      panelResourceIds: ['notes'],
    })
    editor.commands.undo()
    expect(chatComposerDocumentToUserContent(editor.getJSON())).toEqual(createBuddyUserContent())
  })
})

function createEditor() {
  const editor = new TiptapEditor({
    content: userContentToChatComposerDocument(createBuddyUserContent()),
    extensions: [
      StarterKit.configure({ document: false }),
      ChatComposerDocument,
      ChatComposerResourceReference.configure({
        resourcePresentation: id => ({
          iconName: 'file',
          iconUrl: '',
          label: `${id}.png`,
          text: `@${id}.png`,
        }),
      }),
      ChatComposerPromptDirective,
      ChatComposerSessionReference,
      ChatComposerActorReference,
    ],
  })
  editors.push(editor)
  return editor
}

describe('session reference document integrity', () => {
  it('preserves inline placement through persistence and repeated references through undo and redo', () => {
    const editor = createEditor()
    editor.commands.insertContent('参考  的决定继续。')
    editor.commands.setTextSelection(4)
    const reference = { id: 'session-one', title: '订单延期讨论' }
    insertChatComposerSessionReferences(editor, [reference])
    const saved = chatComposerDocumentToUserContent(editor.getJSON())
    expect(saved.body[0]!.content).toEqual([
      { type: 'text', text: '参考 ' },
      { type: 'session_ref', sessionId: reference.id },
      { type: 'text', text: ' 的决定继续。' },
    ])
    const restored = createEditor()
    replaceChatComposerDocument(restored, saved)
    expect(restored.getText()).toBe('参考 @订单延期讨论 的决定继续。')
    expect(chatComposerDocumentToUserContent(restored.getJSON())).toEqual(saved)
    restored.commands.setTextSelection(restored.state.doc.content.size - 1)
    insertChatComposerSessionReferences(restored, [reference])
    expect(chatComposerDocumentToUserContent(restored.getJSON()).sessionReferences).toEqual([reference])
    removeChatComposerSessionReference(restored, reference.id)
    expect(chatComposerDocumentToUserContent(restored.getJSON()).sessionReferences).toBeUndefined()
    restored.commands.undo()
    expect(chatComposerDocumentToUserContent(restored.getJSON()).sessionReferences).toEqual([reference])
    restored.commands.redo()
    expect(restored.getText()).not.toContain('@')
  })

  it('limits unique sessions while allowing repeated mentions and refusing forged inline identities', () => {
    const editor = createEditor()
    const references = Array.from({ length: 17 }, (_, index) => ({ id: `session-${index}`, title: `Session ${index}` }))
    insertChatComposerSessionReferences(editor, references)
    expect(chatComposerDocumentToUserContent(editor.getJSON()).sessionReferences).toHaveLength(16)
    insertChatComposerSessionReferences(editor, [references[0]!])
    expect(chatComposerDocumentToUserContent(editor.getJSON()).body[0]!.content).toHaveLength(17)
    expect(buddyUserContentV1Schema.safeParse({ ...createBuddyUserContent(), body: [{ type: 'paragraph', content: [{ type: 'session_ref', sessionId: 'unknown' }] }] }).success).toBe(false)
  })
})

describe('actor reference document integrity', () => {
  it('preserves stable identity, frozen name and inline position across persistence, deletion and undo', () => {
    const editor = createEditor()
    editor.commands.insertContent('请 @星 检查')
    const reference = { type: 'actor_ref' as const, actorId: 'actor-1', name: '星野' }
    insertChatComposerActorReference(editor, reference, { from: 3, to: 5 })
    const saved = chatComposerDocumentToUserContent(editor.getJSON())
    expect(saved).toEqual({
      version: 1,
      body: [{ type: 'paragraph', content: [
        { type: 'text', text: '请 ' },
        reference,
        { type: 'text', text: '  检查' },
      ] }],
      panelResourceIds: [],
    })
    const restored = createEditor()
    replaceChatComposerDocument(restored, JSON.parse(JSON.stringify(saved)))
    expect(restored.getText()).toBe('请 @星野  检查')
    expect(chatComposerDocumentToUserContent(restored.getJSON())).toEqual(saved)
    restored.commands.setNodeSelection(3)
    restored.commands.deleteSelection()
    expect(getBuddyUserContentActorReferences(chatComposerDocumentToUserContent(restored.getJSON()))).toEqual([])
    restored.commands.undo()
    expect(chatComposerDocumentToUserContent(restored.getJSON())).toEqual(saved)
    restored.commands.redo()
    expect(restored.getText()).toBe('请   检查')
  })

  it('treats external mention HTML and handwritten names as plain text', () => {
    const editor = createEditor()
    editor.commands.insertContent('<p><span data-type="chat-actor-reference" actorId="actor-1" name="星野">@星野</span> @Lexora</p>')
    const content = chatComposerDocumentToUserContent(editor.getJSON())
    expect(content).toEqual(createBuddyUserContent('@星野 @Lexora'))
    expect(getBuddyUserContentActorReferences(content)).toEqual([])
  })
})

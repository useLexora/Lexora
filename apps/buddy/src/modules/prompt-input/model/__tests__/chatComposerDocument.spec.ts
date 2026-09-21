// @vitest-environment jsdom

import type { Editor } from '@tiptap/core'
import { buddyUserContentV1Schema, createBuddyUserContent } from '@buddy-shared/conversation/buddyUserContent'
import { Editor as TiptapEditor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ChatComposerDocument,
  ChatComposerPromptDirective,
  ChatComposerResourceReference,
  insertChatComposerResources,
  insertResolvedChatComposerResource,
  replaceChatComposerDocument,
} from '../../editor/chatComposerResourceEditing'
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
    ],
  })
  editors.push(editor)
  return editor
}

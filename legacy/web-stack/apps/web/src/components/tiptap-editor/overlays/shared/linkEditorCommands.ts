import type { Editor } from '@tiptap/core'
import type { EditorDocumentRange } from './editorRange'

interface LinkRangeCommandOptions {
  range: EditorDocumentRange | null
}

interface LinkHrefCommandOptions extends LinkRangeCommandOptions {
  href: string | null
}

interface LinkTextCommandOptions extends LinkHrefCommandOptions {
  text: string
}

export function restoreLinkSelection(
  editor: Editor,
  range: EditorDocumentRange | null,
) {
  return getLinkChain(editor, range).run()
}

export function applyLinkToSelection(
  editor: Editor,
  options: LinkHrefCommandOptions,
) {
  if (!options.href) {
    return null
  }

  const didApply = getLinkChain(editor, options.range).setLink({
    href: options.href,
  }).run()

  return didApply ? editor.state.selection.to : null
}

export function removeLinkFromSelection(
  editor: Editor,
  range: EditorDocumentRange | null,
) {
  return getLinkChain(editor, range).unsetLink().run()
}

export function replaceExistingLink(
  editor: Editor,
  options: LinkTextCommandOptions,
): EditorDocumentRange | null {
  if (!options.range || !options.href) {
    return null
  }

  const didApply = editor.chain().focus().insertContentAt(
    options.range,
    {
      type: 'text',
      text: options.text,
      marks: [
        {
          type: 'link',
          attrs: {
            href: options.href,
          },
        },
      ],
    },
  ).setTextSelection(options.range.from + options.text.length).unsetMark('link').run()

  return didApply
    ? {
        from: options.range.from,
        to: options.range.from + options.text.length,
      }
    : null
}

export function insertEmptyBlockLink(
  editor: Editor,
  options: LinkTextCommandOptions,
) {
  if (!options.range || !options.href) {
    return false
  }

  return editor.chain().focus().insertContentAt(
    {
      from: options.range.from,
      to: options.range.to,
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: options.text,
          marks: [
            {
              type: 'link',
              attrs: {
                href: options.href,
              },
            },
          ],
        },
      ],
    },
  ).run()
}

export function exitLinkMarkAtPosition(editor: Editor, position: number) {
  editor.chain().focus().setTextSelection(position).unsetMark('link').run()
}

function getLinkChain(editor: Editor, range: EditorDocumentRange | null) {
  const chain = editor.chain().focus()

  if (range) {
    chain.setTextSelection(range)
  }

  return chain.extendMarkRange('link')
}

import type { Editor, JSONContent } from '@tiptap/core'
import { TiptapJsonContentPayloadSchema } from '@haohaoxue/lexora-contracts/tiptap/core'
import { DOMSerializer, Fragment } from '@tiptap/pm/model'
import { getCurrentBlock } from '../commands/currentBlock'

export const LEXORA_BLOCK_CLIPBOARD_TYPE = 'application/x-lexora-block+json'

export async function copyCurrentBlockToClipboard(editor: Editor) {
  const payload = createCurrentBlockClipboardPayload(editor)

  if (!payload) {
    return false
  }

  return writeClipboardPayload(payload)
}

export async function cutCurrentBlockToClipboard(editor: Editor) {
  const copied = await copyCurrentBlockToClipboard(editor)

  if (!copied) {
    return false
  }

  return editor.chain().focus().deleteBlock().run()
}

interface ClipboardPayload {
  html: string
  json: string
  text: string
}

function createCurrentBlockClipboardPayload(editor: Editor): ClipboardPayload | null {
  const currentBlock = getCurrentBlock(editor.state.selection)

  if (!currentBlock) {
    return null
  }

  return {
    html: serializeBlockToHtml(editor, currentBlock.node),
    json: JSON.stringify([currentBlock.node.toJSON()]),
    text: currentBlock.node.textContent,
  }
}

function serializeBlockToHtml(editor: Editor, block: Parameters<typeof Fragment.from>[0]) {
  const container = document.createElement('div')
  const fragment = DOMSerializer.fromSchema(editor.schema).serializeFragment(
    Fragment.from(block),
    {
      document,
    },
  )

  container.appendChild(fragment)
  return container.innerHTML
}

async function writeClipboardPayload(payload: ClipboardPayload) {
  if (typeof navigator === 'undefined' || !navigator.clipboard) {
    return false
  }

  if (typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard.write === 'function') {
    await navigator.clipboard.write([
      new ClipboardItem({
        [LEXORA_BLOCK_CLIPBOARD_TYPE]: new Blob([payload.json], { type: LEXORA_BLOCK_CLIPBOARD_TYPE }),
        'text/html': new Blob([payload.html], { type: 'text/html' }),
        'text/plain': new Blob([payload.text], { type: 'text/plain' }),
      }),
    ])

    return true
  }

  if (typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(payload.text)
    return true
  }

  return false
}

export function parseStructuredClipboardContent(raw: string): JSONContent[] | null {
  if (!raw.trim().length) {
    return null
  }

  try {
    const parsed = TiptapJsonContentPayloadSchema.safeParse(JSON.parse(raw))

    return parsed.success ? parsed.data as JSONContent[] : null
  }
  catch {
    return null
  }
}

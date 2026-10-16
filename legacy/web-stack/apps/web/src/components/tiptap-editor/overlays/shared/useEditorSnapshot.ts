import type { Editor, EditorEvents } from '@tiptap/core'
import { onBeforeUnmount, onMounted, shallowRef } from 'vue'

type EditorSnapshotEvent = 'selectionUpdate' | 'transaction' | 'focus' | 'blur'

const DEFAULT_EDITOR_SNAPSHOT_EVENTS = [
  'selectionUpdate',
  'transaction',
  'focus',
  'blur',
] as const satisfies readonly EditorSnapshotEvent[]

interface UseEditorSnapshotOptions {
  events?: readonly EditorSnapshotEvent[]
}

export function useEditorSnapshot(
  editor: Editor,
  options: UseEditorSnapshotOptions = {},
) {
  const version = shallowRef(0)
  const events = options.events ?? DEFAULT_EDITOR_SNAPSHOT_EVENTS

  function syncSnapshot() {
    version.value += 1
  }

  const eventHandlers = {
    selectionUpdate: (_event?: EditorEvents['selectionUpdate']) => {
      syncSnapshot()
    },
    transaction: (_event?: EditorEvents['transaction']) => {
      syncSnapshot()
    },
    focus: () => {
      syncSnapshot()
    },
    blur: () => {
      syncSnapshot()
    },
  }

  onMounted(() => {
    if (typeof editor.on !== 'function') {
      return
    }

    events.forEach(event => editor.on(event, eventHandlers[event] as never))
  })

  onBeforeUnmount(() => {
    if (typeof editor.off !== 'function') {
      return
    }

    events.forEach(event => editor.off(event, eventHandlers[event] as never))
  })

  return version
}

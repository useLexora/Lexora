import type { Editor } from '@tiptap/core'
import type { BlockTriggerViewStateOptions } from '../catalog/menuRegistry'
import { computed } from 'vue'
import { getBlockTriggerViewState } from '../catalog/menuRegistry'
import { useEditorSnapshot } from '../shared/useEditorSnapshot'

export function useBlockTriggerState(editor: Editor, options: BlockTriggerViewStateOptions = {}) {
  const editorSnapshot = useEditorSnapshot(editor)

  return computed(() => {
    void editorSnapshot.value
    return getBlockTriggerViewState(editor, options)
  })
}

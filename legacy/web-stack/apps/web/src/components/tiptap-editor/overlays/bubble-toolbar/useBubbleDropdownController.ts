import type { Editor } from '@tiptap/core'
import { computed, shallowRef } from 'vue'
import { createMenuActionRegistry } from '../catalog/actionRegistry'
import { useEditorSnapshot } from '../shared/useEditorSnapshot'

/** 气泡下拉控制器选项。 */
interface BubbleDropdownControllerOptions<TState> {
  /** 编辑器实例 */
  editor: Editor
  /** 状态投影器 */
  projectState: (editor: Editor) => TState
}

export function useBubbleDropdownController<TState>(
  options: BubbleDropdownControllerOptions<TState>,
) {
  const { editor, projectState } = options
  const editorSnapshot = useEditorSnapshot(editor)
  const actionRegistry = createMenuActionRegistry({ editor })
  const visible = shallowRef(false)
  const state = computed(() => {
    void editorSnapshot.value
    return projectState(editor)
  })

  function setVisible(nextVisible: boolean) {
    visible.value = nextVisible
  }

  function close() {
    visible.value = false
  }

  return {
    actionRegistry,
    visible,
    state,
    setVisible,
    close,
  }
}

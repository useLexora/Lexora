import type { Editor } from '@tiptap/core'
import type { ComputedRef } from 'vue'
import type { BubbleToolbarAction } from '../catalog/actionRegistry'
import type { BubbleToolbarViewGroup } from '../catalog/bubbleToolbarCatalog'
import type { BubbleToolbarOverlayController } from './useBubbleToolbarOverlay'
import { computed } from 'vue'
import { isImageSelection } from '../../commands/editorActions'
import { createMenuActionRegistry } from '../catalog/actionRegistry'
import { getBubbleToolbarViewGroups } from '../catalog/bubbleToolbarCatalog'
import { useEditorSnapshot } from '../shared/useEditorSnapshot'
import { useBubbleToolbarOverlay } from './useBubbleToolbarOverlay'

/** 选择工具栏视图状态。 */
interface BubbleToolbarState {
  /** 工具栏分组 */
  groups: BubbleToolbarViewGroup[]
}

/** 选择工具栏控制器。 */
export interface BubbleToolbarController {
  /** 视图状态 */
  state: ComputedRef<BubbleToolbarState>
  /** 浮层控制器 */
  overlay: BubbleToolbarOverlayController
  /** 执行动作 */
  handleActionClick: (action: BubbleToolbarAction) => void
}

export function useBubbleToolbar(editor: Editor, options: {
  onRequestComment: () => void
  onRequestAddSelectionContext?: () => void
}): BubbleToolbarController {
  const editorSnapshot = useEditorSnapshot(editor)
  const overlay = useBubbleToolbarOverlay(editor)
  const actionRegistry = createMenuActionRegistry({
    editor,
    linkPanel: overlay.linkPanel,
    onRequestComment: () => options.onRequestComment(),
    onRequestAddSelectionContext: () => options.onRequestAddSelectionContext?.(),
    commentSource: 'bubble-toolbar',
  })

  const state = computed(() => {
    void editorSnapshot.value
    const variant = isImageSelection(editor) ? 'image' : 'text'

    return {
      groups: getBubbleToolbarViewGroups(variant, action => ({
        active: actionRegistry.bubble.isActive(action),
        disabled: actionRegistry.bubble.isDisabled(action),
      })),
    }
  })

  function handleActionClick(action: BubbleToolbarAction) {
    actionRegistry.bubble.execute(action)
  }

  return {
    state,
    overlay,
    handleActionClick,
  } satisfies BubbleToolbarController
}

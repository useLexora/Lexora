<script setup lang="ts">
import type { Editor } from '@tiptap/core'
import type { TurnIntoBlockType } from '../../commands/turnInto'
import TiptapIcon from '../../icons/TiptapIcon.vue'
import BubbleDropdownShell from '../../overlays/bubble-toolbar/BubbleDropdownShell.vue'
import TurnIntoMenuList from '../../overlays/bubble-toolbar/TurnIntoMenuList.vue'
import { useBubbleDropdownController } from '../../overlays/bubble-toolbar/useBubbleDropdownController'
import { getTurnIntoMenuItems } from '../../overlays/catalog/menuRegistry'
import MenuGlyph from '../../overlays/shared/MenuGlyph.vue'

interface StandaloneContentListDropdownProps {
  editor: Editor
  description?: string
}

const props = defineProps<StandaloneContentListDropdownProps>()
const LIST_TARGETS = new Set<TurnIntoBlockType>([
  'bulletList',
  'orderedList',
  'taskList',
] as const)
const {
  actionRegistry,
  close,
  setVisible,
  state,
  visible,
} = useBubbleDropdownController({
  editor: props.editor,
  projectState: (editor) => {
    const items = getTurnIntoMenuItems(editor, 'block-content')
      .filter(item => LIST_TARGETS.has(item.target))
    const activeItem = items.find(item => item.isActive)

    return {
      currentIcon: activeItem?.icon ?? 'list-ul',
      isButtonActive: Boolean(activeItem),
      items,
    }
  },
})

function handleSelect(item: { target: TurnIntoBlockType }) {
  actionRegistry.turnInto.execute(item.target)
  close()
}
</script>

<template>
  <BubbleDropdownShell
    :visible="visible"
    :width="220"
    popper-class="tiptap-bubble-turn-into-popover"
    :description="props.description"
    :active="state.isButtonActive"
    @update:visible="setVisible"
  >
    <template #trigger>
      <span class="tiptap-bubble-btn__icon">
        <MenuGlyph :icon="state.currentIcon" />
      </span>
      <TiptapIcon icon="chevron-down" class="tiptap-bubble-btn__chevron" size="0.75rem" />
    </template>

    <div class="tiptap-turn-into-menu">
      <TurnIntoMenuList :items="state.items" @select="handleSelect" />
    </div>
  </BubbleDropdownShell>
</template>

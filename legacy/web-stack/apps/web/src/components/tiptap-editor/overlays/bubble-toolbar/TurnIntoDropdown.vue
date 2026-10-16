<script setup lang="ts">
import type { Editor } from '@tiptap/core'
import type { TurnIntoMenuItem } from '../catalog/menuRegistry'
import TiptapIcon from '../../icons/TiptapIcon.vue'
import { getBubbleTurnIntoGroups } from '../catalog/menuRegistry'
import MenuGlyph from '../shared/MenuGlyph.vue'
import BubbleDropdownShell from './BubbleDropdownShell.vue'
import TurnIntoMenuList from './TurnIntoMenuList.vue'
import { useBubbleDropdownController } from './useBubbleDropdownController'

type TurnIntoActionItem = TurnIntoMenuItem & { kind: 'action' }

/**
 * 文本转换菜单属性。
 */
interface TurnIntoDropdownProps {
  /** 编辑器实例 */
  editor: Editor
  /** 提示描述 */
  description?: string
}

const props = defineProps<TurnIntoDropdownProps>()
const {
  actionRegistry,
  close,
  setVisible,
  state,
  visible,
} = useBubbleDropdownController({
  editor: props.editor,
  projectState: editor => ({
    groups: getBubbleTurnIntoGroups(editor),
  }),
})

function handleSelect(item: TurnIntoActionItem) {
  actionRegistry.turnInto.execute(item.target)
  close()
}
</script>

<template>
  <BubbleDropdownShell
    :visible="visible"
    :width="236"
    popper-class="tiptap-bubble-turn-into-popover"
    :description="props.description"
    @update:visible="setVisible"
  >
    <template #trigger>
      <span class="tiptap-bubble-btn__icon">
        <MenuGlyph icon="T" />
      </span>
      <TiptapIcon icon="chevron-down" class="tiptap-bubble-btn__chevron" size="0.75rem" />
    </template>

    <div class="tiptap-turn-into-menu">
      <template v-for="(group, index) in state.groups" :key="index">
        <TurnIntoMenuList
          :items="group"
          @select="handleSelect({ ...$event, kind: 'action' })"
        />
        <div
          v-if="index < state.groups.length - 1"
          class="tiptap-turn-into-menu__divider"
        />
      </template>
    </div>
  </BubbleDropdownShell>
</template>

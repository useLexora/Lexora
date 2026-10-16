<script setup lang="ts">
import { computed, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { SvgIcon } from '@/components/svg-icon'
import { useUiStore } from '@/stores/ui'
import { useDocsChatPanel } from '../../composables/useDocsChatPanel'
import { useDocsChatPanelResize } from '../../composables/useDocsChatPanelResize'
import { useDocsSurfaceState } from '../../composables/useDocsSurfaceState'
import DocsChatPanel from '../../widgets/chat-panel'
import DocsSidebarLayout from '../sidebar'

const uiStore = useUiStore()
const { t } = useI18n()
const docsViewRef = useTemplateRef<HTMLElement>('docsView')
const { currentSurface, isDocumentSurface } = useDocsSurfaceState()
const { isOpen: isDocsChatPanelOpen } = useDocsChatPanel()
const isControlCenterSurface = computed(() => currentSurface.value !== 'document')
const isDocumentLibraryVisible = computed(() =>
  !uiStore.documentLibrarySidebarCollapsed && !isControlCenterSurface.value,
)
const {
  handleKeydown: handleDocsChatPanelResizeKeydown,
  isResizing: isDocsChatPanelResizing,
  maxWidthPx: docsChatPanelMaxWidthPx,
  minWidthPx: docsChatPanelMinWidthPx,
  panelWidthStyle: docsChatPanelWidthStyle,
  resetWidth: resetDocsChatPanelWidth,
  startResize: startDocsChatPanelResize,
  widthPx: docsChatPanelWidthPx,
} = useDocsChatPanelResize({
  containerRef: docsViewRef,
  isDocumentLibraryVisible,
})

function showDocumentLibrary() {
  uiStore.setDocumentLibrarySidebarCollapsed(false)
}
</script>

<template>
  <div
    ref="docsView"
    class="docs-view relative flex h-full min-h-0"
    :class="{ 'is-resizing-docs-chat-panel': isDocsChatPanelResizing }"
    :style="docsChatPanelWidthStyle"
  >
    <DocsSidebarLayout v-if="isDocumentLibraryVisible" />

    <ElTooltip
      v-else-if="!isControlCenterSurface"
      :content="t('docs.common.documentLibrary')"
      effect="dark"
      placement="right"
      :show-after="120"
    >
      <ElButton
        text
        class="docs-view__library-restore absolute left-3 top-3 z-[5] h-8 min-w-8 w-8 rounded-lg p-0"
        :title="t('docs.common.documentLibrary')"
        :aria-label="t('docs.common.documentLibrary')"
        @click="showDocumentLibrary"
      >
        <SvgIcon category="ui" icon="pin" size="1rem" />
      </ElButton>
    </ElTooltip>

    <main class="docs-view__surface flex min-h-0 min-w-0 flex-1">
      <RouterView />
    </main>

    <DocsChatPanel
      v-show="isDocumentSurface && isDocsChatPanelOpen"
      :is-resizing="isDocsChatPanelResizing"
      :max-width-px="docsChatPanelMaxWidthPx"
      :min-width-px="docsChatPanelMinWidthPx"
      :width-px="docsChatPanelWidthPx"
      @resize-start="startDocsChatPanelResize"
      @resize-reset="resetDocsChatPanelWidth"
      @resize-keydown="handleDocsChatPanelResizeKeydown"
    />
  </div>
</template>

<style scoped lang="scss">
.docs-view.is-resizing-docs-chat-panel {
  cursor: col-resize;
  user-select: none;
}

.docs-view__library-restore {
  border: 1px solid color-mix(in srgb, var(--brand-border-base) 72%, transparent);
  background: color-mix(in srgb, var(--brand-bg-surface) 92%, transparent);
  color: var(--brand-text-secondary);
  box-shadow: 0 0.5rem 1.25rem color-mix(in srgb, var(--brand-text-primary) 8%, transparent);

  &:hover,
  &:focus-visible {
    background: color-mix(in srgb, var(--brand-primary) 7%, var(--brand-bg-surface));
    color: var(--brand-primary);
  }
}
</style>

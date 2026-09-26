<script setup lang="ts">
import type { ChatReadingPositions } from '../transcript/chatMessageViewport'
import { Pulse20Regular } from '@vicons/fluent'
import { NButton, NPopover } from 'naive-ui'
import { computed, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { provideConversationStatusPanel } from '@/modules/tasks/state/runs/conversationStatusPanel'
import { useConversationStatus } from '@/modules/tasks/state/runs/useConversationStatus'
import { useTaskContext } from '@/modules/tasks/taskContext'
import DesktopTaskSpaceSelector from '@/modules/tasks/widgets/composer/DesktopTaskSpaceSelector.vue'
import { useProvideChatContent } from '@/modules/tasks/widgets/transcript/chatContentContext'
import DesktopChatWorkspace from '@/modules/tasks/widgets/workspace/DesktopChatWorkspace.vue'
import DesktopChatWorkspaceHeader from '@/modules/tasks/widgets/workspace/DesktopChatWorkspaceHeader.vue'
import DesktopConversationStatusPanel from '@/modules/tasks/widgets/workspace/DesktopConversationStatusPanel.vue'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

withDefaults(defineProps<{ readingPositions?: ChatReadingPositions, active?: boolean }>(), { active: true })
const emit = defineEmits<{ ready: [] }>()
const router = useRouter()
const {
  resources: contextActions,
  clipboard,
  tasks,
  notificationTargetMessageId,
  startTask: navigateDraft,
} = useTaskContext()
const { language } = useDesktopUi()
const { t } = useBuddyI18n(language)
const { workspace } = tasks
const { spaces, ...indexActions } = tasks.index
const { activeSpace, activeTaskId, currentTitle } = tasks.session
const startTask = navigateDraft ?? tasks.session.startTask
const chatSession = workspace.session
const viewMode = shallowRef<'chat' | 'canvas'>('chat')
const statusPanelOpen = shallowRef(false)
const { isLoading: statusLoading, load: loadStatus, loadFailed: statusLoadFailed, status: conversationStatus } = useConversationStatus(
  computed(() => chatSession.activeConversationId.value),
)
provideConversationStatusPanel({
  open: () => {
    statusPanelOpen.value = true
    void loadStatus()
  },
})
watch(chatSession.activeConversationId, () => {
  viewMode.value = 'chat'
})
watch(notificationTargetMessageId, (messageId) => {
  if (messageId)
    viewMode.value = 'chat'
}, { flush: 'sync' })
useProvideChatContent({
  canPreviewFile: contextActions.canPreviewFile,
  previewFile: contextActions.previewFile,
  writeClipboardText: text => clipboard.writeText(text),
})
</script>

<template>
  <div class="desktop-task-editor">
    <DesktopChatWorkspaceHeader
      :view-mode="viewMode"
      :can-toggle-canvas="activeTaskId !== null"
      :language="language"
      :title="currentTitle"
      @toggle-canvas="viewMode = viewMode === 'chat' ? 'canvas' : 'chat'"
    >
      <template #title>
        <slot name="title" />
      </template>
      <template #leadingActions>
        <NPopover
          v-model:show="statusPanelOpen"
          placement="bottom-end"
          trigger="click"
          :show-arrow="false"
          :style="{ padding: 0 }"
          @update:show="show => show && loadStatus()"
        >
          <template #trigger>
            <NButton
              class="buddy-icon-button"
              quaternary
              :theme-overrides="{ heightMedium: '2rem' }"
              :type="statusPanelOpen ? 'primary' : 'default'"
              :aria-expanded="statusPanelOpen"
              :aria-label="t('desktop.chat.status.title')"
              data-testid="conversation-status-toggle"
            >
              <template #icon>
                <DesktopIcon :component="Pulse20Regular" :size="18" />
              </template>
            </NButton>
          </template>
          <DesktopConversationStatusPanel
            :current-model-id="workspace.composer.selectedModelId.value"
            :is-loading="statusLoading"
            :language="language"
            :load-failed="statusLoadFailed"
            :status="conversationStatus"
            @refresh="loadStatus"
          />
        </NPopover>
      </template>
      <template #actions>
        <slot name="actions" />
      </template>
    </DesktopChatWorkspaceHeader>
    <DesktopChatWorkspace
      :active="active"
      :reading-positions="readingPositions"
      :view-mode="viewMode"
      :reveal-message-id="notificationTargetMessageId"
      :workspace="workspace"
      @ready="emit('ready')"
      @show-canvas="viewMode = 'canvas'"
      @open-settings="router.push(desktopRouteLocations.settings($event))"
      @open-artifact="contextActions.openArtifact"
      @open-node-artifact="contextActions.openArtifact"
      @open-node-changes="contextActions.openChanges"
      @open-changes="contextActions.openChanges"
    >
      <template v-if="activeTaskId === null" #composerLeadingContext>
        <DesktopTaskSpaceSelector
          :active-space="activeSpace"
          :language="language"
          :spaces="spaces"
          :select-directory="indexActions.selectSpaceDirectory"
          :create-space="indexActions.createSpace"
          @select-space="startTask"
        />
      </template>
    </DesktopChatWorkspace>
  </div>
</template>

<style scoped>
.desktop-task-editor { display: flex; flex: 1; min-width: 0; min-height: 0; flex-direction: column; container: task-pane / size; }
</style>

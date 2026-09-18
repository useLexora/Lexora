<script setup lang="ts">
import type { ChatReadingPositions } from '../transcript/chatMessageViewport'
import { shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useTaskContext } from '@/modules/tasks/taskContext'
import DesktopTaskSpaceSelector from '@/modules/tasks/widgets/composer/DesktopTaskSpaceSelector.vue'
import { useProvideChatContent } from '@/modules/tasks/widgets/transcript/chatContentContext'
import DesktopChatWorkspace from '@/modules/tasks/widgets/workspace/DesktopChatWorkspace.vue'
import DesktopChatWorkspaceHeader from '@/modules/tasks/widgets/workspace/DesktopChatWorkspaceHeader.vue'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'

defineProps<{ readingPositions?: ChatReadingPositions }>()
const router = useRouter()
const {
  resources: contextActions,
  clipboard,
  tasks,
  notificationTargetMessageId,
  startTask: navigateDraft,
} = useTaskContext()
const { language } = useDesktopUi()
const { workspace } = tasks
const { spaces, ...indexActions } = tasks.index
const { activeSpace, activeTaskId, currentTitle } = tasks.session
const startTask = navigateDraft ?? tasks.session.startTask
const chatSession = workspace.session
const viewMode = shallowRef<'chat' | 'canvas'>('chat')
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
      <template #actions>
        <slot name="actions" />
      </template>
    </DesktopChatWorkspaceHeader>
    <DesktopChatWorkspace
      :reading-positions="readingPositions"
      :view-mode="viewMode"
      :reveal-message-id="notificationTargetMessageId"
      :workspace="workspace"
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

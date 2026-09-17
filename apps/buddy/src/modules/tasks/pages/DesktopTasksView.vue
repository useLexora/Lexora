<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useTaskContext } from '@/modules/tasks/taskContext'
import DesktopTaskSpaceSelector from '@/modules/tasks/widgets/composer/DesktopTaskSpaceSelector.vue'
import DesktopTaskIndex from '@/modules/tasks/widgets/task-index/DesktopTaskIndex.vue'
import { useProvideChatContent } from '@/modules/tasks/widgets/transcript/chatContentContext'
import DesktopChatWorkspace from '@/modules/tasks/widgets/workspace/DesktopChatWorkspace.vue'
import DesktopChatWorkspaceHeader from '@/modules/tasks/widgets/workspace/DesktopChatWorkspaceHeader.vue'
import { useConversationSearch } from '@/modules/tasks/widgets/workspace/useConversationSearch'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import DesktopWorkbenchLayout from '@/shared/ui/workbench-layout/DesktopWorkbenchLayout.vue'

const router = useRouter()
const {
  resources: contextActions,
  clipboard,
  tasks,
  notificationTargetMessageId,
} = useTaskContext()
const { language, appSidebarCollapsed } = useDesktopUi()
const { workspace } = tasks
const { pinnedItems, sidebar: taskSidebar, spaces, tasks: taskItems, ...indexActions } = tasks.index
const { activeSpace, activeTaskId, currentTitle, openTask, startTask } = tasks.session
const chatSession = workspace.session
const sidebarCollapsed = computed({
  get: () => taskSidebar.collapsed.value,
  set: value => void taskSidebar.setCollapsed(value),
})
const sidebarWidth = computed({
  get: () => taskSidebar.width.value,
  set: value => void taskSidebar.setWidth(value),
})
const viewMode = shallowRef<'chat' | 'canvas'>('chat')
watch(chatSession.activeConversationId, () => {
  viewMode.value = 'chat'
})
useProvideChatContent({
  canPreviewFile: contextActions.canPreviewFile,
  previewFile: contextActions.previewFile,
  writeClipboardText: text => clipboard.writeText(text),
})
const {
  activeIndex: activeSearchIndex,
  activeMessageId: activeSearchMessageId,
  isLoading: searchLoading,
  isOpen: searchOpen,
  matchingMessageIds,
  query: searchQuery,
  resultCount: searchResultCount,
  ...searchActions
} = useConversationSearch({
  activeBranchId: chatSession.activeBranchId,
  activeConversationId: chatSession.activeConversationId,
  loadMessages: chatSession.listActiveConversationMessages,
})
</script>

<template>
  <DesktopWorkbenchLayout
    v-model:sidebar-collapsed="sidebarCollapsed"
    v-model:sidebar-width="sidebarWidth"
    :language="language"
    sidebar-collapsible
    sidebar-resizable
  >
    <template #sidebar>
      <DesktopTaskIndex
        :active-conversation-id="activeTaskId"
        :marks="tasks.index.marks"
        :app-sidebar-collapsed="appSidebarCollapsed"
        :language="language"
        :pinned-items="pinnedItems"
        :sidebar="taskSidebar"
        :spaces="spaces"
        :select-space-directory="indexActions.selectSpaceDirectory"
        :tasks="taskItems"
        :create-space="indexActions.createSpace"
        :update-space="indexActions.updateSpace"
        @delete-space="indexActions.deleteSpace"
        @delete-task="indexActions.deleteTask"
        @new-task="startTask"
        @open-space-directory="indexActions.openSpaceDirectory"
        @open-task="openTask"
        @rename-task="indexActions.renameTask"
        @update-pinned-items="indexActions.setPinnedItems"
      />
    </template>

    <DesktopChatWorkspaceHeader
      :view-mode="viewMode"
      :active-search-index="activeSearchIndex"
      :can-search-conversation="activeTaskId !== null"
      :conversation-search-loading="searchLoading"
      :conversation-search-open="searchOpen"
      :conversation-search-query="searchQuery"
      :conversation-search-result-count="searchResultCount"
      :language="language"
      :title="currentTitle"
      @toggle-canvas="viewMode = viewMode === 'chat' ? 'canvas' : 'chat'"
      @close-conversation-search="searchActions.close"
      @next-conversation-search-result="searchActions.move(1)"
      @open-conversation-search="searchActions.open"
      @previous-conversation-search-result="searchActions.move(-1)"
      @update-conversation-search="searchActions.setQuery"
    />
    <DesktopChatWorkspace
      :view-mode="viewMode"
      :active-search-message-id="notificationTargetMessageId ?? activeSearchMessageId"
      :workspace="workspace"
      :matching-search-message-ids="matchingMessageIds"
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
  </DesktopWorkbenchLayout>
</template>

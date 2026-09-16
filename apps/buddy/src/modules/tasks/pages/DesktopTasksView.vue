<script setup lang="ts">
import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import type { LocalChangeSetSummary } from '@buddy-shared/changes/changeApi'
import type { LocalRunOutput } from '@buddy-shared/runs/runApi'
import { computed, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useTaskContext } from '@/modules/tasks/taskContext'
import DesktopTaskSpaceSelector from '@/modules/tasks/widgets/composer/DesktopTaskSpaceSelector.vue'
import DesktopTaskResourcePanel from '@/modules/tasks/widgets/context-panel/DesktopTaskResourcePanel.vue'
import { useTaskResourcePanel } from '@/modules/tasks/widgets/context-panel/useTaskResourcePanel'
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
  browser,
  clipboard,
  tasks,
  notificationTargetMessageId,
} = useTaskContext()
const { language, appSidebarCollapsed } = useDesktopUi()
const { workspace } = tasks
const { pinnedItems, spaces, tasks: taskItems, ...indexActions } = tasks.index
const { activeSpace, activeTaskId, currentTitle, openTask, startTask } = tasks.session
const chatSession = workspace.session
const taskSidebarCollapsed = shallowRef(false)
const viewMode = shallowRef<'chat' | 'canvas'>('chat')
const retainedOutputs = shallowRef<readonly LocalRunOutput[]>([])
const retainedChanges = shallowRef<readonly LocalChangeSetSummary[]>([])
const panelOutputs = computed(() => [...workspace.transcript.runOutputs.value, ...retainedOutputs.value])
const panelChanges = computed(() => [...workspace.transcript.changeSets.value, ...retainedChanges.value])
function retainArtifacts(artifacts: readonly LocalArtifact[]) {
  const existing = new Map(retainedOutputs.value.flatMap(output => output.artifacts).map(artifact => [artifact.artifactId, artifact]))
  for (const artifact of artifacts) existing.set(artifact.artifactId, artifact)
  retainedOutputs.value = [...existing.values()].map(artifact => ({ runId: artifact.runId, createdAt: artifact.createdAt, sourceToolCallId: artifact.sourceToolCallId, artifacts: [artifact] }))
}
watch(chatSession.activeConversationId, () => {
  viewMode.value = 'chat'
  retainedOutputs.value = []
  retainedChanges.value = []
})
const contextActions = useTaskResourcePanel({
  activeConversationId: workspace.session.activeConversationId,
  activeSpace,
  spaces,
  activeRunId: computed(() => workspace.execution.activeRun.value?.id ?? null),
  browser,
  changeSets: panelChanges,
  runSignalEvents: workspace.transcript.runSignalEvents,
  runOutputs: panelOutputs,
})
const { artifactCount, isOpen: contextOpen } = contextActions
useProvideChatContent({
  canPreviewFile: contextActions.canPreviewFile,
  previewFile: contextActions.previewFile,
  writeClipboardText: text => clipboard.writeText(text),
})
const changeRevision = computed(() => panelChanges.value.map(set => `${set.changeSetId}:${set.updatedAt}`).join('|'))
function openArtifact(id: string) {
  void contextActions.openArtifact(id)
}
function openNodeArtifact(artifact: LocalArtifact) {
  retainArtifacts([artifact])
  openArtifact(artifact.artifactId)
}
function openNodeChanges(changes: LocalChangeSetSummary) {
  retainedChanges.value = [...retainedChanges.value.filter(item => item.changeSetId !== changes.changeSetId), changes]
  contextActions.openChanges(changes.changeSetId)
}
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
    v-model:sidebar-collapsed="taskSidebarCollapsed"
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
      :artifact-count="artifactCount"
      :can-search-conversation="activeTaskId !== null"
      :conversation-search-loading="searchLoading"
      :conversation-search-open="searchOpen"
      :conversation-search-query="searchQuery"
      :conversation-search-result-count="searchResultCount"
      :context-open="contextOpen"
      :language="language"
      :title="currentTitle"
      @toggle-canvas="viewMode = viewMode === 'chat' ? 'canvas' : 'chat'"
      @close-conversation-search="searchActions.close"
      @next-conversation-search-result="searchActions.move(1)"
      @open-conversation-search="searchActions.open"
      @previous-conversation-search-result="searchActions.move(-1)"
      @toggle-context="contextActions.toggle"
      @update-conversation-search="searchActions.setQuery"
    />
    <DesktopChatWorkspace
      :view-mode="viewMode"
      :active-search-message-id="notificationTargetMessageId ?? activeSearchMessageId"
      :workspace="workspace"
      :matching-search-message-ids="matchingMessageIds"
      @show-canvas="viewMode = 'canvas'"
      @open-settings="router.push(desktopRouteLocations.settings($event))"
      @open-artifact="openArtifact"
      @open-node-artifact="openNodeArtifact"
      @open-node-changes="openNodeChanges"
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

    <template v-if="contextOpen" #context>
      <DesktopTaskResourcePanel
        :panel="contextActions"
        :context="workspace.context"
        :branch-id="chatSession.activeBranchId.value"
        :change-revision="changeRevision"
        :language="language"
      />
    </template>
  </DesktopWorkbenchLayout>
</template>

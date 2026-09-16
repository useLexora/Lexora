import type { LocalConversation } from '@buddy-shared/conversation/conversationApi'
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import type { Ref } from 'vue'
import type { TaskSpaceInput } from '../../state/task-index/typing'
import { computed, shallowRef, watch } from 'vue'

export type TaskSpaceMenuAction = 'delete' | 'edit' | 'new-task' | 'open-directory'

export interface TaskIndexManagementOptions {
  spaces: Readonly<Ref<readonly LocalSpace[]>>
  getUntitledLabel: () => string
  onCreateSpace: (input: TaskSpaceInput) => Promise<boolean>
  onDeleteTask: (conversationId: string) => void
  onDeleteSpace: (spaceId: string) => void
  onNewTask: (spaceId: string) => void
  onOpenSpaceDirectory: (spaceId: string) => void
  onRenameTask: (conversationId: string, title: string) => void
  onUpdateSpace: (input: TaskSpaceInput & { spaceId: string }) => Promise<boolean>
}

export function useTaskIndexManagement(options: TaskIndexManagementOptions) {
  const taskRenameTarget = shallowRef<LocalConversation | null>(null)
  const taskDeleteTarget = shallowRef<LocalConversation | null>(null)
  const taskTitleDraft = shallowRef('')
  const spaceDialogOpen = shallowRef(false)
  const spaceEditId = shallowRef<string | null>(null)
  const spaceDeleteId = shallowRef<string | null>(null)
  const spaceEditTarget = computed({
    get: () => options.spaces.value.find(space => space.id === spaceEditId.value && space.revokedAt === null) ?? null,
    set: (space: LocalSpace | null) => { spaceEditId.value = space?.id ?? null },
  })
  const spaceDeleteTarget = computed({
    get: () => options.spaces.value.find(space => space.id === spaceDeleteId.value && space.revokedAt === null) ?? null,
    set: (space: LocalSpace | null) => { spaceDeleteId.value = space?.id ?? null },
  })
  watch(spaceEditTarget, (space) => {
    if (spaceEditId.value && !space)
      spaceDialogOpen.value = false
  })

  function getTaskTitle(conversation: LocalConversation) {
    return conversation.title?.trim() || options.getUntitledLabel()
  }

  function requestTaskRename(conversation: LocalConversation) {
    taskRenameTarget.value = conversation
    taskTitleDraft.value = getTaskTitle(conversation)
  }

  function requestTaskDelete(conversation: LocalConversation) {
    taskDeleteTarget.value = conversation
  }

  function confirmTaskRename() {
    const target = taskRenameTarget.value
    const title = taskTitleDraft.value.trim()
    if (!target || !title)
      return
    options.onRenameTask(target.id, title)
    taskRenameTarget.value = null
  }

  function confirmTaskDelete() {
    if (!taskDeleteTarget.value)
      return
    options.onDeleteTask(taskDeleteTarget.value.id)
    taskDeleteTarget.value = null
  }

  function openSpaceCreator() {
    spaceEditTarget.value = null
    spaceDialogOpen.value = true
  }

  function selectSpaceMenuAction(space: LocalSpace, action: TaskSpaceMenuAction) {
    if (action === 'open-directory') {
      options.onOpenSpaceDirectory(space.id)
      return
    }
    if (action === 'new-task') {
      options.onNewTask(space.id)
      return
    }
    if (action === 'edit') {
      spaceEditTarget.value = space
      spaceDialogOpen.value = true
      return
    }
    if (action === 'delete')
      spaceDeleteTarget.value = space
  }

  function saveSpace(input: TaskSpaceInput): Promise<boolean> {
    const space = spaceEditTarget.value
    if (spaceEditId.value && !space)
      return Promise.resolve(false)
    return space ? options.onUpdateSpace({ ...input, spaceId: space.id }) : options.onCreateSpace(input)
  }

  function confirmSpaceDelete() {
    const space = spaceDeleteTarget.value
    if (!space || space.activeRunCount > 0)
      return
    options.onDeleteSpace(space.id)
    spaceDeleteTarget.value = null
  }

  return {
    confirmTaskDelete,
    confirmTaskRename,
    confirmSpaceDelete,
    getTaskTitle,
    openSpaceCreator,
    requestTaskDelete,
    requestTaskRename,
    saveSpace,
    selectSpaceMenuAction,
    taskRenameTarget,
    taskDeleteTarget,
    taskTitleDraft,
    spaceDialogOpen,
    spaceEditTarget,
    spaceDeleteTarget,
  }
}

import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { LocalConversation } from '@buddy-shared/conversation/conversationApi'
import type { BuddyApprovalPolicy } from '@buddy-shared/permissions/approvalPolicy'

import type { BuddyExecutionProfile } from '@buddy-shared/permissions/executionProfile'
import type { BuddyPermissionMode } from '@buddy-shared/permissions/permissionMode'
import type { LocalRun } from '@buddy-shared/runs/runApi'
import type { useChatDrafts } from '@/modules/tasks/state/drafts/useChatDrafts'
import {
  resolveBuddyPermissionMode,
  resolveBuddyPermissionSettings,
} from '@buddy-shared/permissions/permissionMode'
import { computed, readonly, shallowRef } from 'vue'

interface ValueRef<T> {
  readonly value: T
}

interface UseChatPermissionSettingsOptions {
  activeConversation: ValueRef<LocalConversation | null>
  activeConversationId: ValueRef<string | null>
  activeRun: ValueRef<LocalRun | null>
  applyConversation: (conversation: LocalConversation) => void
  api: Pick<LexoraDesktopApi['localChat']['conversations'], 'setPermissionSettings'>
  drafts: ReturnType<typeof useChatDrafts>
  onError: (error: unknown) => void
  persistWorkspaceState: () => Promise<boolean>
}

export function useChatPermissionSettings(options: UseChatPermissionSettingsOptions) {
  const isUpdating = shallowRef(false)
  const approvalPolicy = computed<BuddyApprovalPolicy>(() => (
    options.activeConversation.value?.approvalPolicy
    ?? options.drafts.approvalPolicy.value
  ))
  const executionProfile = computed<BuddyExecutionProfile>(() => (
    options.activeConversation.value?.executionProfile
    ?? options.drafts.executionProfile.value
  ))
  const permissionMode = computed(() => resolveBuddyPermissionMode({
    approvalPolicy: approvalPolicy.value,
    executionProfile: executionProfile.value,
  }))
  const canUpdate = computed(() => (
    !isUpdating.value
    && (
      options.activeConversationId.value === null
      || options.activeConversation.value !== null
    )
  ))

  async function setPermissionMode(mode: BuddyPermissionMode): Promise<boolean> {
    if (mode === permissionMode.value)
      return true
    if (!canUpdate.value)
      return false

    const settings = resolveBuddyPermissionSettings(mode)
    const conversation = options.activeConversation.value
    isUpdating.value = true
    try {
      if (conversation) {
        const updated = await options.api.setPermissionSettings(conversation.id, settings)
        options.applyConversation(updated)
        return await options.persistWorkspaceState()
      }

      const targetKey = options.drafts.targetKey.value
      const previous = {
        approvalPolicy: options.drafts.approvalPolicy.value,
        executionProfile: options.drafts.executionProfile.value,
      }
      options.drafts.setPermissionSettings(settings)
      if (await options.persistWorkspaceState())
        return true
      options.drafts.setPermissionSettings(previous, targetKey)
      return false
    }
    catch (error) {
      options.onError(error)
      return false
    }
    finally {
      isUpdating.value = false
    }
  }

  return {
    approvalPolicy: readonly(approvalPolicy),
    canUpdate: readonly(canUpdate),
    executionProfile: readonly(executionProfile),
    isUpdating: readonly(isUpdating),
    permissionMode: readonly(permissionMode),
    setPermissionMode,
  }
}

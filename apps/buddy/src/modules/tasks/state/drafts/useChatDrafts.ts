import type { BuddyUserContentV1 } from '@buddy-shared/conversation/buddyUserContent'
import type { LocalComposerDraft } from '@buddy-shared/conversation/composerApi'

import type { BuddyPermissionSettings } from '@buddy-shared/permissions/permissionMode'
import type { JSONContent } from '@tiptap/core'
import type { ComputedRef } from 'vue'
import type { ChatDrafts, ChatDraftSnapshot, ChatDraftState, ComposerDraftReceipt } from './typing'
import { buddyUserContentToText, createBuddyUserContent } from '@buddy-shared/conversation/buddyUserContent'
import { BUDDY_DEFAULT_APPROVAL_POLICY } from '@buddy-shared/permissions/approvalPolicy'
import { BUDDY_DEFAULT_EXECUTION_PROFILE } from '@buddy-shared/permissions/executionProfile'
import { computed, shallowReactive, shallowRef, watch } from 'vue'
import {
  chatComposerDocumentToUserContent,
  createChatComposerContentFromText,
  getChatComposerResourceIds,
  pruneChatComposerResources,
  userContentToChatComposerDocument,
} from '@/modules/prompt-input'
import { createDraftValueFingerprint } from '../../model/drafts/draftValueFingerprint'

interface UseChatDraftsOptions {
  onChange: () => void
  targetKey: ComputedRef<string>
}

export function useChatDrafts(options: UseChatDraftsOptions): ChatDrafts {
  const draftsByScope = shallowReactive(new Map<string, ChatDraftState>())
  const isolatedDraft = shallowRef<{ sourceKey: string, targetKey: string } | null>(null)
  watch(options.targetKey, () => isolatedDraft.value = null, { flush: 'sync' })
  const activeTargetKey = computed(() => (
    isolatedDraft.value?.sourceKey === options.targetKey.value
      ? isolatedDraft.value.targetKey
      : options.targetKey.value
  ))
  watch(
    () => [activeTargetKey.value, draftsByScope.has(activeTargetKey.value)] as const,
    ([key, exists]) => {
      if (!exists)
        draftsByScope.set(key, emptyDraft(key))
    },
    { flush: 'sync', immediate: true },
  )
  const currentDraft = computed(() => load(activeTargetKey.value))
  const composerContent = computed(() => userContentToChatComposerDocument(currentDraft.value.content))
  const draft = computed(() => buddyUserContentToText(currentDraft.value.content))
  const draftId = computed(() => currentDraft.value.draftId)
  const editorKey = computed(() => currentDraft.value.editorSessionId)
  const approvalPolicy = computed(() => currentDraft.value.approvalPolicy)
  const executionProfile = computed(() => currentDraft.value.executionProfile)

  function updateComposerContent(text: string, value: JSONContent | null) {
    const document = value ?? createChatComposerContentFromText(text)
    updateCurrentDraft({ content: chatComposerDocumentToUserContent(document) })
  }

  function updateCurrentDraft(value: Partial<ChatDraftState>) {
    updateDraft(activeTargetKey.value, value)
  }

  function updateDraft(targetKey: string, value: Partial<ChatDraftState>) {
    const current = load(targetKey)
    draftsByScope.set(targetKey, {
      ...current,
      ...value,
      editVersion: current.editVersion + 1,
    })
    options.onChange()
  }

  function load(key: string): ChatDraftState {
    const existing = draftsByScope.get(key)
    if (existing)
      return existing
    const value = emptyDraft(key)
    draftsByScope.set(key, value)
    return value
  }

  function findDraft(draftId: string) {
    return [...draftsByScope.entries()].find(([, value]) => value.draftId === draftId)
  }

  function updateSourceDocument(draftId: string, transform: (document: JSONContent) => JSONContent) {
    const source = findDraft(draftId)
    if (!source)
      return
    const [key, current] = source
    const content = chatComposerDocumentToUserContent(
      transform(userContentToChatComposerDocument(current.content)),
    )
    if (JSON.stringify(content) === JSON.stringify(current.content))
      return
    draftsByScope.set(key, {
      ...current,
      content,
      editVersion: current.editVersion + 1,
    })
    options.onChange()
  }

  function snapshot(targetKey: string): ChatDraftSnapshot {
    return cloneSnapshot(targetKey, load(targetKey))
  }

  function confirmRemote(
    submitted: ChatDraftSnapshot,
    remote: LocalComposerDraft,
    replaceContent: boolean,
  ) {
    const source = findDraft(submitted.draftId)
    if (!source)
      return false
    const [key, current] = source
    if (current.editorSessionId !== submitted.editorSessionId || (current.revision !== null && remote.revision < current.revision))
      return false
    const unchanged = current.editorSessionId === submitted.editorSessionId
      && current.editVersion === submitted.editVersion
    draftsByScope.set(key, {
      ...current,
      ...(replaceContent && unchanged
        ? {
            approvalPolicy: remote.executionConfig.approvalPolicy,
            content: cloneContent(remote.content),
            editorSessionId: current.draftId === remote.draftId ? current.editorSessionId : crypto.randomUUID(),
            executionProfile: remote.executionConfig.executionProfile,
            modelSelection: remote.modelSelection,
          }
        : {}),
      confirmedSnapshot: createDraftValueFingerprint(remote),
      draftId: remote.draftId,
      revision: remote.revision,
    })
    return true
  }

  return {
    acknowledgeSend(receipt: ComposerDraftReceipt, targetKey: string) {
      const source = findDraft(receipt.draftId)
      if (!source)
        return false
      const [sourceKey, current] = source
      if (current.revision !== receipt.sourceRevision)
        return current.revision === receipt.committedRevision
      const wasConfirmed = current.confirmedSnapshot === stateValueFingerprint(current)
      const empty = createBuddyUserContent()
      const destination = draftsByScope.get(targetKey)
      const key = destination && destination.draftId !== current.draftId ? sourceKey : targetKey
      if (sourceKey.startsWith('draft:') && sourceKey === options.targetKey.value && sourceKey !== key)
        isolatedDraft.value = { sourceKey, targetKey: key }
      if (sourceKey !== key)
        draftsByScope.delete(sourceKey)
      const next = {
        ...current,
        confirmedSnapshot: stateValueFingerprint({ ...current, content: empty }),
        content: wasConfirmed ? empty : current.content,
        editorSessionId: crypto.randomUUID(),
        editVersion: current.editVersion + (wasConfirmed ? 1 : 0),
        revision: receipt.committedRevision,
      }
      draftsByScope.set(key, next)
      if (!wasConfirmed)
        options.onChange()
      return wasConfirmed
    },
    appendResourcePanel(draftId: string, resourceIds: readonly string[], editorSessionId?: string) {
      if (editorSessionId && findDraft(draftId)?.[1].editorSessionId !== editorSessionId)
        return
      updateSourceDocument(draftId, document => ({
        ...document,
        attrs: {
          ...document.attrs,
          panelResourceIds: [
            ...new Set([...(document.attrs?.panelResourceIds ?? []), ...resourceIds]),
          ],
        },
      }))
    },
    approvalPolicy,
    composerContent,
    resumeIsolated(targetKey: string) {
      if (!draftsByScope.has(targetKey)) {
        const current = currentDraft.value
        draftsByScope.set(targetKey, { ...emptyDraft(), approvalPolicy: current.approvalPolicy, executionProfile: current.executionProfile, modelSelection: current.modelSelection })
      }
      isolatedDraft.value = { sourceKey: options.targetKey.value, targetKey }
      options.onChange()
    },
    beginIsolated(targetKey: string, content: BuddyUserContentV1) {
      if (isolatedDraft.value)
        return false
      const current = currentDraft.value
      const existing = load(targetKey)
      draftsByScope.set(targetKey, {
        ...existing,
        approvalPolicy: current.approvalPolicy,
        content: cloneContent(content),
        editorSessionId: crypto.randomUUID(),
        editVersion: existing.editVersion + 1,
        executionProfile: current.executionProfile,
        modelSelection: current.modelSelection,
      })
      isolatedDraft.value = { sourceKey: options.targetKey.value, targetKey }
      options.onChange()
      return true
    },
    cancelIsolated(targetKey: string) {
      if (isolatedDraft.value?.targetKey !== targetKey)
        return false
      isolatedDraft.value = null
      return true
    },
    completeIsolated(receipt: ComposerDraftReceipt, targetKey: string, sourceKey: string) {
      const current = draftsByScope.get(sourceKey)
      if (
        !current
        || current.draftId !== receipt.draftId
        || current.revision !== receipt.sourceRevision
      ) {
        return false
      }
      const wasConfirmed = current.confirmedSnapshot === stateValueFingerprint(current)
      const empty = createBuddyUserContent()
      draftsByScope.delete(sourceKey)
      draftsByScope.set(targetKey, {
        ...current,
        confirmedSnapshot: stateValueFingerprint({ ...current, content: empty }),
        content: wasConfirmed ? empty : current.content,
        editorSessionId: crypto.randomUUID(),
        editVersion: current.editVersion + (wasConfirmed ? 1 : 0),
        revision: receipt.committedRevision,
      })
      if (isolatedDraft.value?.targetKey === sourceKey)
        isolatedDraft.value = null
      options.onChange()
      return true
    },
    confirmOpen(
      submitted: ChatDraftSnapshot,
      remote: LocalComposerDraft,
      preserveLocalContent = false,
    ) {
      return confirmRemote(submitted, remote, !preserveLocalContent)
    },
    confirmSave(submitted: ChatDraftSnapshot, remote: LocalComposerDraft) {
      return confirmRemote(submitted, remote, false)
    },
    async discard(key: string) {
      draftsByScope.delete(key)
      options.onChange()
    },
    async discardConversation(conversationId: string) {
      const keys = [...draftsByScope.keys()].filter(
        key => key.startsWith(`conversation:${conversationId}:`)
          || key.startsWith(`message-edit:${conversationId}:`)
          || key.startsWith(`message-followup:${conversationId}:`),
      )
      for (const key of keys)
        draftsByScope.delete(key)
      options.onChange()
    },
    draft,
    draftId,
    editorKey,
    executionProfile,
    hydrate(values: ReadonlyArray<{ draft: LocalComposerDraft, targetKey: string }>) {
      draftsByScope.clear()
      for (const value of values)
        draftsByScope.set(value.targetKey, fromRemote(value.draft))
      load(options.targetKey.value)
    },
    isEditorSessionCurrent(value: Pick<ChatDraftState, 'draftId' | 'editorSessionId'>) {
      return findDraft(value.draftId)?.[1].editorSessionId === value.editorSessionId
    },
    isPersisted(value: ChatDraftSnapshot) {
      return value.revision !== null && value.confirmedSnapshot === stateValueFingerprint(value)
    },
    isUnchanged(value: ChatDraftSnapshot) {
      const current = findDraft(value.draftId)?.[1]
      return current?.editorSessionId === value.editorSessionId
        && current.editVersion === value.editVersion
    },
    listSnapshots: () => [...draftsByScope.keys()].map(snapshot),
    load,
    modelSelection: computed(() => currentDraft.value.modelSelection),
    rejectResources(draftId: string, resourceIds: readonly string[]) {
      updateSourceDocument(
        draftId,
        document => pruneChatComposerResources(document, new Set(resourceIds)),
      )
    },
    resourceIdsForDraft(draftId: string) {
      const value = findDraft(draftId)?.[1]
      return getChatComposerResourceIds(
        value ? userContentToChatComposerDocument(value.content) : null,
      )
    },
    setModelSelection(modelSelection: LocalComposerDraft['modelSelection']) {
      const current = currentDraft.value.modelSelection
      if (current === modelSelection || (current && modelSelection
        && current.modelId === modelSelection.modelId
        && current.providerId === modelSelection.providerId
        && current.reasoning === modelSelection.reasoning
        && current.serviceTier === modelSelection.serviceTier)) {
        return
      }
      updateCurrentDraft({ modelSelection })
    },
    setUserContent(content: BuddyUserContentV1) {
      if (JSON.stringify(content) === JSON.stringify(currentDraft.value.content))
        return
      updateCurrentDraft({ content: cloneContent(content) })
    },
    setPermissionSettings(settings: BuddyPermissionSettings, targetKey = activeTargetKey.value) {
      const current = load(targetKey)
      if (current.approvalPolicy === settings.approvalPolicy && current.executionProfile === settings.executionProfile)
        return
      updateDraft(targetKey, settings)
    },
    snapshot,
    targetKey: activeTargetKey,
    updateComposerContent,
  }
}

function emptyDraft(targetKey = ''): ChatDraftState {
  return {
    approvalPolicy: BUDDY_DEFAULT_APPROVAL_POLICY,
    confirmedSnapshot: null,
    content: createBuddyUserContent(),
    draftId: targetKey.startsWith('draft:') ? targetKey.slice(6) : crypto.randomUUID(),
    editorSessionId: crypto.randomUUID(),
    editVersion: 0,
    executionProfile: BUDDY_DEFAULT_EXECUTION_PROFILE,
    modelSelection: null,
    revision: null,
  }
}

function fromRemote(draft: LocalComposerDraft): ChatDraftState {
  return {
    approvalPolicy: draft.executionConfig.approvalPolicy,
    confirmedSnapshot: createDraftValueFingerprint(draft),
    content: cloneContent(draft.content),
    draftId: draft.draftId,
    editorSessionId: crypto.randomUUID(),
    editVersion: 0,
    executionProfile: draft.executionConfig.executionProfile,
    modelSelection: draft.modelSelection,
    revision: draft.revision,
  }
}

function cloneSnapshot(targetKey: string, draft: ChatDraftState): ChatDraftSnapshot {
  return {
    ...draft,
    content: cloneContent(draft.content),
    targetKey,
  }
}

function cloneContent(content: BuddyUserContentV1): BuddyUserContentV1 {
  return JSON.parse(JSON.stringify(content)) as BuddyUserContentV1
}

function stateValueFingerprint(draft: Pick<
  ChatDraftState,
  'approvalPolicy' | 'content' | 'executionProfile' | 'modelSelection'
>): string {
  return createDraftValueFingerprint({
    content: draft.content,
    executionConfig: {
      approvalPolicy: draft.approvalPolicy,
      executionProfile: draft.executionProfile,
    },
    modelSelection: draft.modelSelection,
  })
}

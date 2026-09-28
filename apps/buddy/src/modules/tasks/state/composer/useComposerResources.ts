import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { BuddyComposerResource, BuddyComposerSource, BuddySpaceFileSource } from '@buddy-shared/conversation/composerResource'
import type { Ref } from 'vue'
import type { ComposerResourcesState, ComposerResourceView } from './typing'
import { BUDDY_MEDIA_EXTENSIONS } from '@buddy-shared/conversation/attachmentFormats'

import { BUDDY_ATTACHMENT_COUNT_LIMIT, BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT, getAttachmentKind } from '@buddy-shared/conversation/attachmentPolicy'
import { formatLocalChatPublicError, parseLocalChatPublicError } from '@buddy-shared/runtime/localChatError'
import { computed, shallowReactive } from 'vue'

interface UseComposerResourcesOptions {
  api: LocalChatApi['composerResources']
  draftId: Readonly<Ref<string>>
  getReferencedIds: (draftId: string) => readonly string[]
  onError: (error: unknown) => void
  onLimitExceeded: () => void
  onRejected: (draftId: string, resourceIds: readonly string[]) => void
}

export function useComposerResources(options: UseComposerResourcesOptions): ComposerResourcesState {
  const entries = shallowReactive(new Map<string, ComposerResourceView>())
  const sources = new Map<string, File>()
  const localReferenceIds = new Set<string>()
  const accepting = new Set<Promise<void>>()
  const rejectedIds = shallowReactive(new Set<string>())
  const resources = computed(() => [...entries.values()].filter(entry => entry.resource.draftId === options.draftId.value))

  let disposed = false
  const dirtyDrafts = new Set<string>()
  const revisions = new Map<string, number>()
  let refreshing = false
  const stopChanges = options.api.onChanged(({ draftIds }) => {
    for (const id of draftIds) {
      if (id === options.draftId.value || [...entries.values()].some(entry => entry.resource.draftId === id))
        refresh(id)
    }
  })

  function refresh(draftId: string) {
    if (disposed)
      return
    revisions.set(draftId, (revisions.get(draftId) ?? 0) + 1)
    dirtyDrafts.add(draftId)
    if (!refreshing) {
      refreshing = true
      queueMicrotask(() => {
        void reconcile()
      })
    }
  }

  async function reconcile() {
    const failures = new Map<string, number>()
    try {
      while (dirtyDrafts.size) {
        if (disposed)
          break
        const draftId = dirtyDrafts.values().next().value!
        dirtyDrafts.delete(draftId)
        const revision = revisions.get(draftId)
        try {
          const current = await options.api.list(draftId)
          if (disposed || revisions.get(draftId) !== revision)
            continue
          const ids = new Set(current.map(resource => resource.resourceId))
          for (const [id, entry] of entries) {
            if (entry.accepted && entry.resource.draftId === draftId && !ids.has(id))
              entries.delete(id)
          }
          for (const resource of current) update(resource, true, true)
        }
        catch (error) {
          const attempt = (failures.get(draftId) ?? 0) + 1
          failures.set(draftId, attempt)
          if (attempt < 3)
            dirtyDrafts.add(draftId)
          else options.onError(error)
        }
      }
    }
    finally { refreshing = false }
  }

  function update(resource: BuddyComposerResource, accepted = true, authoritative = false) {
    if (disposed)
      return
    if (resource.state === 'ready')
      sources.delete(resource.resourceId)
    entries.set(resource.resourceId, { accepted, canRetry: sources.has(resource.resourceId), resource })
    if (accepted && !authoritative && revisions.has(resource.draftId))
      refresh(resource.draftId)
  }

  async function complete(resource: BuddyComposerResource) {
    const file = sources.get(resource.resourceId)
    if (!file)
      return
    try {
      const completed = await options.api.complete({
        bytes: new Uint8Array(await file.arrayBuffer()),
        draftId: resource.draftId,
        resourceId: resource.resourceId,
      })
      update(completed)
      if (completed.state === 'failed')
        options.onError(new Error(formatLocalChatPublicError({ code: 'ATTACHMENT_IMPORT_FAILED', retryable: true })))
    }
    catch (error) {
      try {
        update(await options.api.fail({ draftId: resource.draftId, resourceId: resource.resourceId }))
      }
      catch {
        update({ ...metadata(resource), errorCode: 'IMPORT_INTERRUPTED', state: 'failed' })
      }
      options.onError(error)
    }
  }

  async function accept(draftId: string, incoming: readonly BuddyComposerResource[]) {
    let accepted: readonly BuddyComposerResource[]
    try {
      accepted = await options.api.accept({
        draftId,
        resources: incoming.map(({ resourceId, name, nameSource, mimeType, sizeBytes, sourcePath }) => ({ resourceId, name, nameSource, mimeType, sizeBytes, sourcePath, storage: localReferenceIds.has(resourceId) ? 'reference' as const : 'snapshot' as const })),
      })
    }
    catch (error) {
      const persisted = await options.api.list(draftId)
      accepted = incoming.flatMap(resource => persisted.filter(item => item.resourceId === resource.resourceId))
      if (accepted.length !== incoming.length) {
        const ids = incoming.map(resource => resource.resourceId)
        for (const id of ids) {
          rejectedIds.add(id)
          entries.delete(id)
          sources.delete(id)
        }
        options.onRejected(draftId, ids)
        throw error
      }
    }
    for (const resource of accepted) {
      update(resource)
      if (resource.state === 'importing')
        void complete(resource)
    }
  }

  function begin(files: readonly File[], origin: 'file' | 'clipboard' = 'file'): readonly string[] {
    const currentIds = new Set(options.getReferencedIds(options.draftId.value))
    const currentBytes = totalBytes(currentIds)
    if (!files.length)
      return []
    if (
      currentIds.size + files.length > BUDDY_ATTACHMENT_COUNT_LIMIT
      || currentBytes + files.reduce((total, file) => total + (window.lexoraDesktop?.clipboard.getFilePath(file) ? 0 : file.size), 0) > BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT
    ) {
      options.onLimitExceeded()
      return []
    }
    const draftId = options.draftId.value
    const incoming = files.map((file): BuddyComposerResource => {
      const resourceId = crypto.randomUUID()
      sources.set(resourceId, file)
      const sourcePath = window.lexoraDesktop?.clipboard.getFilePath(file) || undefined
      if (sourcePath)
        localReferenceIds.add(resourceId)
      const resource: BuddyComposerResource = {
        draftId,
        kind: getAttachmentKind(file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : BUDDY_MEDIA_EXTENSIONS[`.${file.name.split('.').at(-1)?.toLowerCase()}` as keyof typeof BUDDY_MEDIA_EXTENSIONS] ?? file.type),
        mimeType: file.type,
        name: file.name,
        nameSource: origin === 'clipboard' && file.type.startsWith('image/') && !sourcePath ? 'clipboard' : 'file',
        sourcePath,
        resourceId,
        sizeBytes: file.size,
        state: 'importing',
      }
      update(resource, false)
      return resource
    })
    const pending = accept(draftId, incoming)
    accepting.add(pending)
    void pending.catch((error) => {
      for (const resource of incoming) {
        if (entries.get(resource.resourceId)?.accepted === false)
          update({ ...metadata(resource), errorCode: 'IMPORT_INTERRUPTED', state: 'failed' }, false)
      }
      options.onError(error)
    }).finally(() => accepting.delete(pending))
    return incoming.map(resource => resource.resourceId)
  }

  async function retry(resourceId: string) {
    const entry = entries.get(resourceId)
    if (!entry || !entry.canRetry || entry.resource.state !== 'failed')
      return
    try {
      if (!entry.accepted) {
        const pending = accept(entry.resource.draftId, [entry.resource])
        accepting.add(pending)
        try {
          await pending
        }
        finally {
          accepting.delete(pending)
        }
      }
      else {
        const resource = await options.api.retry({ draftId: entry.resource.draftId, resourceId })
        update(resource)
        if (resource.state === 'importing')
          await complete(resource)
      }
    }
    catch (error) {
      options.onError(error)
    }
  }

  return {
    dispose() {
      disposed = true
      stopChanges()
      dirtyDrafts.clear()
    },
    async selectSource(source: BuddyComposerSource, draftId = options.draftId.value) {
      try {
        const resource = await options.api.selectSource(
          { draftId, resourceId: crypto.randomUUID(), source },
          options.getReferencedIds(draftId),
        )
        update(resource)
        return resource.resourceId
      }
      catch (error) {
        handleSelectionError(error)
        return null
      }
    },
    async selectSpaceFile(source: BuddySpaceFileSource, draftId = options.draftId.value) {
      try {
        const resource = await options.api.selectSpaceFile(
          { draftId, resourceId: crypto.randomUUID(), source },
          options.getReferencedIds(draftId),
        )
        update(resource)
        return resource.resourceId
      }
      catch (error) {
        handleSelectionError(error)
        return null
      }
    },
    begin,
    rejectedIds,
    resources,
    retry,
    async restore(draftId: string) {
      for (const resource of await options.api.list(draftId)) {
        if (!entries.has(resource.resourceId))
          update(resource)
      }
    },
    async selectFiles(draftId: string) {
      try {
        const selected = await options.api.selectFiles(draftId, options.getReferencedIds(draftId))
        for (const resource of selected)
          update(resource)
        return selected.map(resource => resource.resourceId)
      }
      catch (error) {
        if (isAttachmentLimitError(error)) {
          options.onLimitExceeded()
          return []
        }
        throw error
      }
    },
    async whenAccepted() {
      await Promise.allSettled(accepting)
      if ([...entries.values()].some(entry => !entry.accepted && options.getReferencedIds(entry.resource.draftId).includes(entry.resource.resourceId)))
        throw new Error('Resource acceptance is pending')
    },
  }

  function totalBytes(ids: ReadonlySet<string>): number {
    return [...ids].reduce(
      (total, id) => total + (entries.get(id)?.resource.localReference || localReferenceIds.has(id) ? 0 : entries.get(id)?.resource.sizeBytes ?? 0),
      0,
    )
  }

  function handleSelectionError(error: unknown) {
    if (isAttachmentLimitError(error))
      options.onLimitExceeded()
    else
      options.onError(error)
  }
}

function isAttachmentLimitError(error: unknown): boolean {
  return error instanceof Error
    && parseLocalChatPublicError(error.message)?.code === 'ATTACHMENT_LIMIT_EXCEEDED'
}

function metadata(resource: BuddyComposerResource) {
  const { draftId, kind, mimeType, name, nameSource, resourceId, sizeBytes, sourcePath } = resource
  return { draftId, kind, mimeType, name, nameSource, resourceId, sizeBytes, sourcePath }
}

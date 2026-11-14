import type { DraftRecoveryApi, DraftRecoveryOwner, DraftRecoveryRecord } from '@buddy-shared/conversation/draftRecovery'
import type { ChatDrafts } from './typing'
import { sameDraftRecoveryOwner } from '@buddy-shared/conversation/draftRecovery'
import { computed, shallowReactive, shallowRef } from 'vue'

export function createDraftRecovery(options: { api?: DraftRecoveryApi, drafts: ChatDrafts, onError: (error: unknown) => void }) {
  const copies = shallowRef<readonly DraftRecoveryRecord[]>([])
  const recoveredTargets = new Set<string>()
  const available = shallowReactive(new Map<string, DraftRecoveryRecord[]>())
  const owned = new Map<string, { sequence: number, fingerprint: string }>()
  let owner: DraftRecoveryOwner | null = null
  let initialized = false
  let initialization: Promise<void> | null = null
  let pending: Promise<void> | null = null
  let requested = false
  let scheduled = false

  function restoreScope(targetKey: string) {
    const records = available.get(targetKey)
    if (!records)
      return
    available.delete(targetKey)
    const [record] = records
    if (records.length !== 1 || !record || !options.drafts.restoreSnapshot(record.snapshot)) {
      copies.value = [...copies.value, ...records]
      return
    }
    owned.set(record.snapshot.editorSessionId, { sequence: record.sequence, fingerprint: JSON.stringify(record.snapshot) })
    recoveredTargets.add(targetKey)
  }

  function initialize(): Promise<void> {
    initialization ??= (async () => {
      const loaded = await options.api?.load()
      owner = loaded?.owner ?? null
      if (owner) {
        for (const record of loaded!.records) {
          if (!sameDraftRecoveryOwner(owner, record.owner)) {
            copies.value = [...copies.value, record]
            continue
          }
          const records = available.get(record.snapshot.targetKey) ?? []
          available.set(record.snapshot.targetKey, [...records, record])
        }
        for (const snapshot of options.drafts.listSnapshots())
          restoreScope(snapshot.targetKey)
      }
      initialized = true
    })().catch((error) => {
      initialization = null
      throw error
    })
    return initialization
  }

  async function drain() {
    while (requested) {
      requested = false
      if (!owner || !options.api)
        return
      const snapshots = options.drafts.listSnapshots().filter(snapshot => snapshot.editVersion > 0 || snapshot.revision !== null || owned.has(snapshot.editorSessionId))
      for (const snapshot of snapshots) {
        const fingerprint = JSON.stringify(snapshot)
        const previous = owned.get(snapshot.editorSessionId)
        if (previous?.fingerprint === fingerprint)
          continue
        const sequence = (previous?.sequence ?? 0) + 1
        await options.api.write({ owner, sequence, snapshot })
        owned.set(snapshot.editorSessionId, { sequence, fingerprint })
      }
      const current = new Set(snapshots.map(snapshot => snapshot.editorSessionId))
      for (const [editorSessionId, record] of owned) {
        if (current.has(editorSessionId))
          continue
        await options.api.remove({ owner, editorSessionId, sequence: record.sequence + 1 })
        owned.delete(editorSessionId)
      }
    }
  }

  async function flush(): Promise<void> {
    if (!initialized)
      await initialize()
    requested = true
    if (pending)
      return pending
    pending = drain().then(() => {
      pending = null
      return requested ? flush() : undefined
    }, (error) => {
      pending = null
      throw error
    })
    return pending
  }

  function schedule() {
    requested = true
    if (!initialized || scheduled)
      return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      void flush().catch(options.onError)
    })
  }

  return { initialize, flush, schedule, restoreScope, recoveredTargets, copies: computed(() => [...copies.value, ...[...available.values()].flat()]) }
}

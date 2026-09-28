import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type { BuddyDefaultModel } from '../../../shared/providers/providerInput'
import type { BuddyModel } from './providerSchemas'
import { randomUUID } from 'node:crypto'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'

export interface ProviderStateInput {
  readonly providers: readonly { id: string, enabled: boolean, presentation: unknown, execution: unknown }[]
  readonly models: readonly { model: EventSnapshot<BuddyModel>, execution: unknown }[]
  readonly defaultModel: BuddyDefaultModel | null
}
export interface ProviderCommit {
  readonly revision: number
  readonly catalogRevision: number
  readonly commitId: string
  readonly reason: 'initialize' | 'configuration' | 'metadata' | 'discovery'
  readonly providers: readonly { providerId: string, kind: 'added' | 'changed' | 'removed', executionChanged: boolean, enabled: boolean }[]
  readonly models: readonly { providerId: string, modelId: string, facets: readonly ('execution' | 'availability' | 'presentation')[], current: EventSnapshot<BuddyModel> | null }[]
  readonly defaultModelChanged: boolean
  readonly defaultModel: BuddyDefaultModel | null
}
export class ProviderState {
  readonly #changes = new Emitter<ProviderCommit>(() => console.error('PROVIDER_OBSERVER_FAILED'))
  readonly onDidCommit = this.#changes.event
  readonly #read: () => ProviderStateInput
  #current: ProviderStateInput
  #revision = 0
  #catalogRevision = 0
  #depth = 0

  constructor(read: () => ProviderStateInput) {
    this.#read = read
    this.#current = copyEventSnapshot(read())
  }

  get snapshot() {
    return copyEventSnapshot({ revision: this.#revision, catalogRevision: this.#catalogRevision, providers: this.#current.providers.map(({ id, enabled }) => ({ id, enabled })), models: this.#current.models.map(entry => entry.model), defaultModel: this.#current.defaultModel })
  }

  commit<T>(reason: ProviderCommit['reason'], operation: () => T): T {
    this.#depth++
    try {
      return operation()
    }
    finally {
      this.#depth--
      if (!this.#depth)
        this.#publish(reason)
    }
  }

  dispose(): void { this.#changes.dispose() }

  #publish(reason: ProviderCommit['reason']): void {
    const current = copyEventSnapshot(this.#read())
    const beforeProviders = new Map(this.#current.providers.map(provider => [provider.id, provider]))
    const afterProviders = new Map(current.providers.map(provider => [provider.id, provider]))
    const providers: ProviderCommit['providers'][number][] = []
    for (const id of new Set([...beforeProviders.keys(), ...afterProviders.keys()])) {
      const before = beforeProviders.get(id)
      const after = afterProviders.get(id)
      if (equal(before, after))
        continue
      providers.push({ providerId: id, kind: !before ? 'added' : !after ? 'removed' : 'changed', executionChanged: !before || !after || before.enabled !== after.enabled || !equal(before.execution, after.execution), enabled: after?.enabled ?? false })
    }
    const key = (model: EventSnapshot<BuddyModel>) => JSON.stringify([model.providerId, model.id])
    const beforeModels = new Map(this.#current.models.map(entry => [key(entry.model), entry]))
    const afterModels = new Map(current.models.map(entry => [key(entry.model), entry]))
    const models: ProviderCommit['models'][number][] = []
    for (const id of new Set([...beforeModels.keys(), ...afterModels.keys()])) {
      const before = beforeModels.get(id)
      const after = afterModels.get(id)
      if (equal(modelValue(before), modelValue(after)))
        continue
      const model = (after ?? before)!.model
      const facets: Array<'execution' | 'availability' | 'presentation'> = []
      if (!before || !after || !equal(before.execution, after.execution))
        facets.push('execution')
      if (!before || !after || before.model.enabled !== after.model.enabled || before.model.available !== after.model.available)
        facets.push('availability')
      if (!equal(before?.model, after?.model))
        facets.push('presentation')
      models.push({ providerId: model.providerId, modelId: model.id, facets, current: after?.model ?? null })
    }
    const defaultModelChanged = !equal(this.#current.defaultModel, current.defaultModel)
    this.#current = current
    if (!providers.length && !models.length && !defaultModelChanged)
      return
    if (models.length)
      this.#catalogRevision++
    this.#changes.fire(copyEventSnapshot({ revision: ++this.#revision, catalogRevision: this.#catalogRevision, commitId: randomUUID(), reason, providers, models, defaultModelChanged, defaultModel: current.defaultModel }))
  }
}
function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function modelValue(entry: ProviderStateInput['models'][number] | undefined) {
  if (!entry)
    return entry
  const { lastSeenAt: _seen, ...model } = entry.model
  return { model, execution: entry.execution }
}

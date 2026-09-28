import type { Api, Message, Model } from '@earendil-works/pi-ai'
import type { ToolInfo } from '@earendil-works/pi-coding-agent'
import type { BuddyCapabilityResourceRevision } from '../BuddyCapability'
import type { BuddyToolDisclosurePolicy, ToolSearchInput } from './toolDiscoveryContract'
import { randomUUID } from 'node:crypto'
import { Emitter } from '../../../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../../../shared/events/eventSnapshot'
import { ToolDisclosure } from './ToolDisclosure'

export type ActiveToolReason = 'initial' | 'discovery' | 'request' | 'context' | 'model' | 'tree' | 'compact' | 'resume'
export interface SessionToolSnapshot {
  readonly instanceId: string
  readonly revision: number
  readonly disclosureRevision: number
  readonly resources: readonly BuddyCapabilityResourceRevision[]
  readonly discovered: readonly string[]
  readonly active: readonly string[]
  readonly model: { readonly provider: string, readonly id: string } | null
  readonly status: 'initializing' | 'ready' | 'degraded' | 'disposed'
}
export interface SessionToolChange {
  readonly kind: 'catalog-accepted' | 'disclosure-changed' | 'active-applied' | 'application-failed' | 'disposed'
  readonly reason: ActiveToolReason | 'restore'
  readonly snapshot: SessionToolSnapshot
}
export class SessionToolCapabilities {
  readonly #changes = new Emitter<SessionToolChange>(() => console.error('SESSION_TOOLS_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  readonly #instanceId = randomUUID()
  readonly #resources: readonly BuddyCapabilityResourceRevision[]
  #disclosure?: ToolDisclosure
  #revision = 0
  #active: readonly string[] = Object.freeze([])
  #model: SessionToolSnapshot['model'] = null
  #status: SessionToolSnapshot['status'] = 'initializing'

  constructor(resources: readonly BuddyCapabilityResourceRevision[] = []) {
    this.#resources = copyEventSnapshot(resources)
  }

  get snapshot(): SessionToolSnapshot {
    return Object.freeze({ instanceId: this.#instanceId, revision: this.#revision, resources: this.#resources, disclosureRevision: this.#disclosure?.snapshot.revision ?? 0, discovered: this.#disclosure?.snapshot.discovered ?? Object.freeze([]), active: this.#active, model: this.#model, status: this.#status })
  }

  initialize(tools: readonly ToolInfo[], resident: readonly string[], policies: readonly BuddyToolDisclosurePolicy[]): void {
    this.#assertCurrent()
    this.#disclosure?.dispose()
    this.#disclosure = new ToolDisclosure(tools, resident, policies)
    this.#disclosure.onDidChange(event => this.#publish('disclosure-changed', event.reason))
    this.#status = 'initializing'
    this.#publish('catalog-accepted', 'initial')
  }

  search(input: ToolSearchInput, model: Model<Api> | undefined) {
    this.#assertCurrent()
    if (!this.#disclosure)
      throw new Error('SESSION_TOOLS_NOT_INITIALIZED')
    return this.#disclosure.search(input, model)
  }

  restore(messages: readonly Message[]): void {
    this.#assertCurrent()
    this.#disclosure?.restore(messages)
  }

  connectedTools(model: Model<Api> | undefined) {
    return this.#disclosure?.connectedTools(model) ?? []
  }

  apply(model: Model<Api> | undefined, reason: ActiveToolReason, adapter: { getActiveTools: () => string[], setActiveTools: (tools: string[]) => void }): void {
    this.#assertCurrent()
    if (!this.#disclosure)
      return
    const desired = this.#disclosure.active(model)
    const nextModel = model ? Object.freeze({ provider: model.provider, id: model.id }) : null
    try {
      if (JSON.stringify(adapter.getActiveTools()) !== JSON.stringify(desired))
        adapter.setActiveTools(desired)
      const actual = Object.freeze([...adapter.getActiveTools()])
      const changed = this.#status !== 'ready' || JSON.stringify(actual) !== JSON.stringify(this.#active) || JSON.stringify(nextModel) !== JSON.stringify(this.#model)
      this.#active = actual
      this.#model = nextModel
      this.#status = 'ready'
      if (changed)
        this.#publish('active-applied', reason)
    }
    catch (error) {
      this.#status = 'degraded'
      this.#publish('application-failed', reason)
      throw error
    }
  }

  dispose(): void {
    if (this.#status === 'disposed')
      return
    this.#disclosure?.dispose()
    this.#status = 'disposed'
    this.#publish('disposed', 'context')
    this.#changes.dispose()
  }

  #assertCurrent(): void {
    if (this.#status === 'disposed')
      throw new Error('SESSION_TOOLS_DISPOSED')
  }

  #publish(kind: SessionToolChange['kind'], reason: SessionToolChange['reason']): void {
    this.#revision++
    this.#changes.fire(Object.freeze({ kind, reason, snapshot: this.snapshot }))
  }
}

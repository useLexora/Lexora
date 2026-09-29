import type { Message } from '@earendil-works/pi-ai'
import type { ToolInfo } from '@earendil-works/pi-coding-agent'
import type { BuddyCapabilityResourceRevision } from '../BuddyCapability'
import type { ToolDisclosureResolution } from './ToolDisclosure'
import type { BuddyToolDisclosurePolicy, BuddyToolExposureContext, BuddyToolExposureResolver, ToolSearchInput } from './toolDiscoveryContract'
import type { ToolDiscoveryState } from './toolDiscoveryState'
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
  readonly direct: readonly string[]
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
  readonly #resolveExposure: BuddyToolExposureResolver | undefined
  #disclosure?: ToolDisclosure
  #revision = 0
  #active: readonly string[] = Object.freeze([])
  #direct: readonly string[] = Object.freeze([])
  #model: SessionToolSnapshot['model'] = null
  #status: SessionToolSnapshot['status'] = 'initializing'

  constructor(resources: readonly BuddyCapabilityResourceRevision[] = [], resolveExposure?: BuddyToolExposureResolver) {
    this.#resources = copyEventSnapshot(resources)
    this.#resolveExposure = resolveExposure
  }

  get snapshot(): SessionToolSnapshot {
    return Object.freeze({ instanceId: this.#instanceId, revision: this.#revision, resources: this.#resources, disclosureRevision: this.#disclosure?.snapshot.revision ?? 0, discovered: this.#disclosure?.snapshot.discovered ?? Object.freeze([]), direct: this.#direct, active: this.#active, model: this.#model, status: this.#status })
  }

  get persistedState(): ToolDiscoveryState { return this.#disclosure?.persistedState ?? { version: 1, discovered: [] } }

  initialize(tools: readonly ToolInfo[], baseline: readonly string[], policies: readonly BuddyToolDisclosurePolicy[]): void {
    this.#assertCurrent()
    this.#disclosure?.dispose()
    this.#disclosure = new ToolDisclosure(tools, baseline, policies, this.#resolveExposure)
    this.#disclosure.onDidChange(event => this.#publish('disclosure-changed', event.reason))
    this.#status = 'initializing'
    this.#publish('catalog-accepted', 'initial')
  }

  search(input: ToolSearchInput, context: BuddyToolExposureContext) {
    this.#assertCurrent()
    if (!this.#disclosure)
      throw new Error('SESSION_TOOLS_NOT_INITIALIZED')
    return this.#disclosure.search(input, context)
  }

  restore(messages: readonly Message[], state?: ToolDiscoveryState): void {
    this.#assertCurrent()
    this.#disclosure?.restore(messages, state)
  }

  resolve(context: BuddyToolExposureContext): ToolDisclosureResolution {
    this.#assertCurrent()
    if (!this.#disclosure)
      throw new Error('SESSION_TOOLS_NOT_INITIALIZED')
    return this.#disclosure.resolve(context)
  }

  apply(resolution: ToolDisclosureResolution, reason: ActiveToolReason, adapter: { getActiveTools: () => string[], setActiveTools: (tools: string[]) => void }): void {
    this.#assertCurrent()
    const { active: desired, direct, model: nextModel } = resolution
    try {
      if (JSON.stringify(adapter.getActiveTools()) !== JSON.stringify(desired))
        adapter.setActiveTools(desired)
      const actual = Object.freeze([...adapter.getActiveTools()])
      if (JSON.stringify(actual) !== JSON.stringify(desired))
        throw new Error('SESSION_TOOLS_APPLICATION_MISMATCH')
      const changed = this.#status !== 'ready' || JSON.stringify(actual) !== JSON.stringify(this.#active) || JSON.stringify(direct) !== JSON.stringify(this.#direct) || JSON.stringify(nextModel) !== JSON.stringify(this.#model)
      this.#active = actual
      this.#direct = Object.freeze(direct)
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

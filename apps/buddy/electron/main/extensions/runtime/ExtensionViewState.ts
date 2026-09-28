import type { ExtensionViewEvents, ExtensionViewNotification } from '../../../../shared/extensions/extensionEvents'
import type { ExtensionViewCursor, ExtensionViewPolicy, ExtensionViewSnapshot, ExtensionViewSynchronization, ExtensionViewUpdate } from '../../../../shared/extensions/extensionViewProjection'
import { EventBus } from '../../../../shared/events/EventBus'
import { copyEventSnapshot } from '../../../../shared/events/eventSnapshot'
import { ownExtensionViewSnapshot, projectExtensionViewEvent } from '../../../../shared/extensions/extensionViewProjection'

const BUFFER_LIMIT = 64
export class ExtensionViewState {
  readonly #bus = new EventBus<ExtensionViewEvents>(() => console.error('EXTENSION_EVENT_LISTENER_FAILED'))
  readonly events = this.#bus.subscriber
  readonly #resynchronize?: () => Promise<ExtensionViewSynchronization>
  #policy: ExtensionViewPolicy = { decoration: false, control: false, interaction: false }
  #state: ExtensionViewSnapshot = copyEventSnapshot({ workbench: { values: {}, pages: [] }, environment: { language: 'zh-CN', colorScheme: 'light', colors: {} }, visible: false, mount: null, anchor: null, control: null })
  #cursor: ExtensionViewCursor | null = null
  #buffer: ExtensionViewUpdate[] = []
  #lost: ExtensionViewCursor | null = null
  #sync: Promise<void> | null = null
  #attempts = 0
  #needsSync = false
  #disposed = false

  constructor(resynchronize?: () => Promise<ExtensionViewSynchronization>) {
    this.#resynchronize = resynchronize
  }

  get snapshot() { return this.#state }
  get synchronizationStatus() { return this.#sync ? 'resynchronizing' : this.#needsSync ? 'degraded' : this.#cursor ? 'current' : 'initializing' }

  initialize(state: ExtensionViewSnapshot, decoration: boolean, cursor?: ExtensionViewCursor, interaction = false): void {
    if (this.#disposed)
      return
    this.#policy = Object.freeze({ decoration, control: state.control !== null, interaction })
    this.#state = ownExtensionViewSnapshot(state, this.#policy)
    if (cursor) {
      this.#install({ ...cursor, snapshot: state }, false)
      this.#drain()
    }
  }

  accept(event: ExtensionViewNotification): void {
    if (this.#disposed)
      return
    const projected = projectExtensionViewEvent(this.#state, event, this.#policy)
    if (!projected)
      return
    this.#state = projected.snapshot
    this.#bus.emit(projected.event)
  }

  acceptUpdate(update: ExtensionViewUpdate): void {
    if (this.#disposed || !update || typeof update.streamId !== 'string' || !Number.isSafeInteger(update.sequence) || update.sequence < 1)
      return
    if (this.#cursor?.streamId === update.streamId && update.sequence <= this.#cursor.sequence)
      return
    if (this.#buffer.some(event => event.streamId === update.streamId && event.sequence === update.sequence))
      return
    if (!this.#sync && this.#attempts >= 3 && this.#buffer.every(event => event.streamId !== update.streamId || event.sequence < update.sequence))
      this.#attempts = 0
    this.#buffer.push(copyEventSnapshot<unknown>(update) as ExtensionViewUpdate)
    if (this.#buffer.length > BUFFER_LIMIT) {
      const lost = this.#buffer.shift()!
      this.#lost = { streamId: lost.streamId, sequence: lost.sequence }
    }
    if (this.#cursor)
      this.#drain()
  }

  dispose(): void {
    this.#disposed = true
    this.#buffer = []
    this.#bus.dispose()
  }

  #install(value: ExtensionViewSynchronization, notify: boolean): void {
    if (!value || typeof value.streamId !== 'string' || !Number.isSafeInteger(value.sequence) || value.sequence < 0)
      throw new Error('EXTENSION_VIEW_SNAPSHOT_INVALID')
    if (this.#cursor?.streamId === value.streamId && this.#cursor.sequence > value.sequence)
      throw new Error('EXTENSION_VIEW_SNAPSHOT_STALE')
    const previous = this.#state
    const transient = notify && this.#cursor?.streamId === value.streamId
      ? this.#buffer.filter(update => update.streamId === value.streamId && update.sequence <= value.sequence && ['view:message:received', 'interaction:activated', 'composer:input:received'].includes(update.event.type)).sort((a, b) => a.sequence - b.sequence)
      : []
    this.#state = ownExtensionViewSnapshot(value.snapshot, this.#policy)
    this.#cursor = Object.freeze({ streamId: value.streamId, sequence: value.sequence })
    this.#buffer = this.#buffer.filter(event => event.streamId === value.streamId && event.sequence > value.sequence)
    if (this.#lost && (this.#lost.streamId !== value.streamId || this.#lost.sequence <= value.sequence))
      this.#lost = null
    this.#needsSync = false
    if (notify)
      this.#notifyDifferences(previous)
    for (const update of transient) this.accept(update.event)
  }

  #drain(): void {
    if (!this.#cursor || this.#disposed)
      return
    this.#buffer.sort((a, b) => a.sequence - b.sequence)
    while (this.#buffer.length) {
      const next = this.#buffer[0]!
      if (next.streamId !== this.#cursor.streamId || next.sequence !== this.#cursor.sequence + 1)
        break
      this.#buffer.shift()
      this.#cursor = Object.freeze({ streamId: next.streamId, sequence: next.sequence })
      this.#attempts = 0
      this.accept(next.event)
    }
    this.#needsSync = Boolean(this.#buffer.length || (this.#lost?.streamId === this.#cursor.streamId && this.#lost.sequence > this.#cursor.sequence))
    if (this.#needsSync)
      this.#requestSynchronization()
    else this.#attempts = 0
  }

  #requestSynchronization(): void {
    if (this.#sync || !this.#resynchronize || this.#attempts >= 3 || this.#disposed)
      return
    this.#attempts++
    this.#sync = Promise.resolve().then(() => this.#resynchronize!()).then((snapshot) => {
      if (this.#disposed)
        return
      this.#install(snapshot, true)
      this.#drain()
    }).catch(() => { this.#needsSync = true }).finally(() => {
      this.#sync = null
      if (this.#needsSync)
        this.#requestSynchronization()
    })
  }

  #notifyDifferences(previous: ExtensionViewSnapshot): void {
    const current = this.#state
    const publish = (key: keyof ExtensionViewSnapshot, event: ExtensionViewNotification) => {
      if (JSON.stringify(previous[key]) !== JSON.stringify(current[key]))
        this.#bus.emit(event)
    }
    publish('workbench', { type: 'workbench:context:changed', data: { context: current.workbench } })
    publish('environment', { type: 'view:environment:changed', data: { environment: current.environment } })
    publish('visible', { type: 'view:visibility:changed', data: { visible: current.visible } })
    const mount = current.mount ?? (previous.mount ? { ...previous.mount, visible: false } : null)
    if (mount)
      publish('mount', { type: 'view:mount:changed', data: { mount } })
    const anchor = current.anchor ?? (previous.anchor ? { ...previous.anchor, visible: false } : null)
    if (anchor && this.#policy.decoration)
      publish('anchor', { type: 'view:anchor:changed', data: { anchor } })
    if (current.control && this.#policy.control)
      publish('control', { type: 'control:changed', data: { control: current.control } })
  }
}

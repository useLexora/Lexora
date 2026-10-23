import type { BuddyResourceQuote, BuddyTextQuote, BuddyUserContentV1 } from '@buddy-shared/conversation/buddyUserContent'
import type { InjectionKey } from 'vue'
import { appendBuddyResourceQuote, buddyResourceQuoteSchema } from '@buddy-shared/conversation/buddyUserContent'
import { inject, nextTick, shallowReactive, shallowRef, watch } from 'vue'

export interface SelectionReferenceTarget {
  id: string
  identity: string
  scope: string
  label: string
  read: () => BuddyUserContentV1
  write: (content: BuddyUserContentV1) => void
}
export interface SelectionReferenceSource { identity: string, owner: string | null }
export interface SelectionReferenceRequest {
  viewId: string
  sourceIdentity: string
  quote: BuddyResourceQuote
  targets: readonly Pick<SelectionReferenceTarget, 'id' | 'identity' | 'label'>[]
  defaultId: string | null
  isSplit: boolean
}
export type SelectionReferenceResult = 'added' | 'duplicate' | 'limit' | 'unavailable'

export interface SelectionReferenceLocateRequest {
  signal: AbortSignal
  current: () => boolean
  reveal: (id: string, quote: BuddyTextQuote, current?: () => boolean) => Promise<boolean>
}
export type SelectionReferenceLocateHandler = (request: SelectionReferenceLocateRequest) => Promise<boolean>
export interface SelectionReferenceProvider {
  captureSource?: (viewId: string) => SelectionReferenceSource | null
  resolveLocate?: (quote: BuddyResourceQuote) => SelectionReferenceLocateHandler | null
}

interface ProviderRegistration {
  owner: string
  generation: number
  provider: SelectionReferenceProvider
}
type RevealHandler = (quote: BuddyTextQuote, current: () => boolean) => Promise<boolean>

export function getDirectSelectionReferenceTarget(request: Pick<SelectionReferenceRequest, 'targets' | 'defaultId' | 'isSplit'>) {
  const target = request.targets[0]
  return !request.isSplit && request.targets.length === 1 && target?.id === request.defaultId ? target : undefined
}

export class WorkbenchSelectionReferences {
  readonly #providers = shallowReactive(new Map<string, ProviderRegistration>())
  readonly #reveals = shallowReactive(new Map<string, { reveal: RevealHandler }>())
  readonly #operation = shallowRef(0)
  #generation = 0
  #disposed = false
  #pending: { registration: ProviderRegistration, cancel: () => void } | null = null

  constructor(readonly options: {
    targets: () => readonly SelectionReferenceTarget[]
    isSplit?: () => boolean
    available?: () => boolean
    captureLocateScope?: () => (() => boolean)
  }) {}

  targets(): readonly SelectionReferenceTarget[] {
    return this.#available() ? [...new Map(this.options.targets().map(target => [target.identity, target])).values()] : []
  }

  registerProvider(owner: string, provider: SelectionReferenceProvider): () => void {
    if (this.#disposed)
      return () => {}
    const registration = { owner, provider, generation: ++this.#generation }
    if (this.#pending?.registration === this.#providers.get(owner))
      this.#pending?.cancel()
    this.#providers.delete(owner)
    this.#providers.set(owner, registration)
    return () => {
      if (this.#providers.get(owner) !== registration)
        return
      this.#providers.delete(owner)
      if (this.#pending?.registration === registration)
        this.#pending.cancel()
    }
  }

  registerReveal(id: string, reveal: RevealHandler): () => void {
    if (this.#disposed)
      return () => {}
    const registration = { reveal }
    this.#reveals.set(id, registration)
    return () => {
      if (this.#reveals.get(id) === registration)
        this.#reveals.delete(id)
    }
  }

  async reveal(id: string, quote: BuddyTextQuote, current: () => boolean): Promise<boolean> {
    await nextTick()
    const registration = this.#reveals.get(id)
    const active = () => !this.#disposed && current() && this.#reveals.get(id) === registration
    if (!registration || !active())
      return false
    return await registration.reveal(quote, active) && active()
  }

  captureSource(viewId: string): SelectionReferenceSource | null {
    if (!this.#available())
      return null
    for (const registration of [...this.#providers.values()].reverse()) {
      const source = registration.provider.captureSource?.(viewId)
      if (source) {
        return {
          identity: JSON.stringify([registration.owner, registration.generation, source.identity]),
          owner: source.owner,
        }
      }
    }
    return null
  }

  capture(viewId: string, quote: BuddyResourceQuote): SelectionReferenceRequest | null {
    const scope = this.captureScope(viewId)
    const parsed = buddyResourceQuoteSchema.safeParse(quote)
    return scope && parsed.success ? { ...scope, quote: parsed.data } : null
  }

  captureScope(viewId: string): Omit<SelectionReferenceRequest, 'quote'> | null {
    const source = this.captureSource(viewId)
    if (!source)
      return null
    const targets = this.targets()
    const preferred = source.owner ? targets.find(target => target.scope === source.owner) : targets.length === 1 ? targets[0] : undefined
    return {
      viewId,
      sourceIdentity: source.identity,
      targets: targets.map(({ id, identity, label }) => ({ id, identity, label })),
      defaultId: preferred?.id ?? null,
      isSplit: this.options.isSplit?.() ?? targets.length > 1,
    }
  }

  add(request: SelectionReferenceRequest, targetId: string): SelectionReferenceResult {
    const captured = request.targets.find(target => target.id === targetId)
    const target = this.targets().find(target => target.id === targetId)
    if (!this.isSourceCurrent(request) || !captured || !target || captured.identity !== target.identity)
      return 'unavailable'
    const appended = appendBuddyResourceQuote(target.read(), request.quote)
    if (appended.result === 'added')
      target.write(appended.content)
    return appended.result
  }

  isSourceCurrent(request: SelectionReferenceRequest): boolean {
    return this.captureSource(request.viewId)?.identity === request.sourceIdentity
  }

  async locate(quote: BuddyResourceQuote): Promise<boolean> {
    const operation = ++this.#operation.value
    this.#pending?.cancel()
    this.#pending = null
    if (!this.#available())
      return false
    try {
      const scopeCurrent = this.options.captureLocateScope?.() ?? (() => true)
      for (const registration of [...this.#providers.values()].reverse()) {
        const handler = registration.provider.resolveLocate?.(quote)
        if (handler)
          return await this.#locate(registration, handler, operation, scopeCurrent)
      }
      return false
    }
    catch { return false }
  }

  async #locate(registration: ProviderRegistration, handler: SelectionReferenceLocateHandler, operation: number, scopeCurrent: () => boolean): Promise<boolean> {
    const active = shallowRef(true)
    const abort = new AbortController()
    const cancelled = Promise.withResolvers<boolean>()
    const pending = {
      registration,
      cancel: () => {
        if (!active.value)
          return
        abort.abort()
        active.value = false
        cancelled.resolve(false)
      },
    }
    this.#pending = pending
    const timer = setTimeout(pending.cancel, 10_000)
    const current = () => active.value && this.#available() && this.#operation.value === operation
      && this.#providers.get(registration.owner) === registration && scopeCurrent()
    const stop = watch(current, valid => !valid && pending.cancel(), { flush: 'sync' })
    try {
      if (!current())
        return false
      const result = handler({
        signal: abort.signal,
        current,
        reveal: (id, quote, sourceCurrent) => this.reveal(id, quote, () => current() && (sourceCurrent?.() ?? true)),
      })
      return await Promise.race([result.then(value => value && current()), cancelled.promise])
    }
    finally {
      stop()
      abort.abort()
      active.value = false
      clearTimeout(timer)
      if (this.#pending === pending)
        this.#pending = null
    }
  }

  #available(): boolean {
    return !this.#disposed && (this.options.available?.() ?? true)
  }

  dispose(): void {
    this.#disposed = true
    this.#operation.value++
    this.#pending?.cancel()
    this.#pending = null
    this.#providers.clear()
    this.#reveals.clear()
  }
}
export const workbenchSelectionReferencesKey: InjectionKey<WorkbenchSelectionReferences> = Symbol('workbench-selection-references')
export function useSelectionReferences(): WorkbenchSelectionReferences | null {
  return inject(workbenchSelectionReferencesKey, null)
}

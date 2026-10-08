import type { DesktopSelectionEditCommand } from '@buddy-electron/shared/desktopApi'
import type { BuddyResourceQuote, BuddyUserContentV1 } from '@buddy-shared/conversation/buddyUserContent'
import type { InjectionKey } from 'vue'
import { appendBuddyResourceQuote, buddyResourceQuoteSchema } from '@buddy-shared/conversation/buddyUserContent'
import { inject } from 'vue'

export interface SelectionReferenceEditSource {
  restore: () => boolean
  executeLocal?: (command: DesktopSelectionEditCommand) => boolean
}

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

/** Capture identities, never a global active input or stale draft body. */
export class WorkbenchSelectionReferences {
  constructor(readonly options: {
    targets: () => readonly SelectionReferenceTarget[]
    source: (viewId: string) => SelectionReferenceSource | null
    locate: (quote: BuddyResourceQuote) => Promise<boolean>
    editSelection?: (command: DesktopSelectionEditCommand) => Promise<void>
    isSplit?: () => boolean
  }) {}

  capture(viewId: string, quote: BuddyResourceQuote): SelectionReferenceRequest | null {
    const scope = this.captureScope(viewId)
    const parsed = buddyResourceQuoteSchema.safeParse(quote)
    return scope && parsed.success ? { ...scope, quote: parsed.data } : null
  }

  captureScope(viewId: string): Omit<SelectionReferenceRequest, 'quote'> | null {
    const source = this.options.source(viewId)
    if (!source)
      return null
    const unique = new Map(this.options.targets().map(target => [target.identity, target]))
    const targets = [...unique.values()]
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
    const source = this.options.source(request.viewId)
    const captured = request.targets.find(target => target.id === targetId)
    const target = this.options.targets().find(target => target.id === targetId)
    if (!source || source.identity !== request.sourceIdentity || !captured || !target || captured.identity !== target.identity)
      return 'unavailable'
    const appended = appendBuddyResourceQuote(target.read(), request.quote)
    if (appended.result === 'added')
      target.write(appended.content)
    return appended.result
  }

  isSourceCurrent(request: SelectionReferenceRequest): boolean {
    return this.options.source(request.viewId)?.identity === request.sourceIdentity
  }

  locate(quote: BuddyResourceQuote): Promise<boolean> {
    return this.options.locate(quote)
  }
}
export const workbenchSelectionReferencesKey: InjectionKey<WorkbenchSelectionReferences> = Symbol('workbench-selection-references')
export function useSelectionReferences(): WorkbenchSelectionReferences | null {
  return inject(workbenchSelectionReferencesKey, null)
}

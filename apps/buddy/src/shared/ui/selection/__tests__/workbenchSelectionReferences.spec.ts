import type { BuddyFileQuote, BuddyUserContentV1 } from '@buddy-shared/conversation/buddyUserContent'
import type { SelectionReferenceSource, SelectionReferenceTarget } from '../workbenchSelectionReferences'
import { buddyUserContentToText, createBuddyUserContent } from '@buddy-shared/conversation/buddyUserContent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, shallowRef } from 'vue'
import { WorkbenchSelectionReferences } from '../workbenchSelectionReferences'

const quote: BuddyFileQuote = { id: 'q', text: 'selected snapshot', source: { kind: 'file', title: 'notes.md', file: { spaceId: 's', directoryId: 'd', revision: 1, path: 'notes.md' }, format: 'markdown' }, textOffset: 3 }
function fixture() {
  const content = new Map<string, BuddyUserContentV1>([['a', createBuddyUserContent('A')], ['b', createBuddyUserContent('B')]])
  const write = vi.fn((id: string, value: BuddyUserContentV1) => content.set(id, value))
  const targets: SelectionReferenceTarget[] = ['a', 'b'].map(id => ({ id, identity: `${id}:draft:branch:epoch`, scope: `task:${id}`, label: `Pane ${id}`, read: () => content.get(id)!, write: value => write(id, value) }))
  let source: SelectionReferenceSource | null = { identity: 'file:source:1', owner: 'task:a' }
  const host = new WorkbenchSelectionReferences({ targets: () => targets })
  const unregister = host.registerProvider('test', { captureSource: () => source, resolveLocate: () => async () => true })
  return { content, targets, write, host, unregister, source: (value: SelectionReferenceSource | null) => source = value }
}

describe('workbench selection target routing', () => {
  it('prefers the associated task, permits another target, and writes only once without replacing newer input', () => {
    const f = fixture()
    const request = f.host.capture('file-view', quote)!
    expect(request.defaultId).toBe('a')
    f.content.set('b', createBuddyUserContent('B typed after menu opened'))
    expect(f.host.add(request, 'b')).toBe('added')
    expect(f.write).toHaveBeenCalledTimes(1)
    expect(f.content.get('a')?.resourceQuotes).toBeUndefined()
    expect(buddyUserContentToText(f.content.get('b')!)).toBe('B typed after menu opened')
    expect(f.content.get('b')!.body[0]!.content.at(-1)).toEqual({ type: 'quote_ref', quoteKind: 'resource', quoteId: quote.id })
    expect(f.content.get('b')?.resourceQuotes).toEqual([quote])
    expect(f.host.add(request, 'b')).toBe('duplicate')
    expect(f.write).toHaveBeenCalledTimes(1)
  })

  it('requires a choice with multiple unassociated inputs, but defaults a sole input', () => {
    const f = fixture()
    f.source({ identity: 'independent-file', owner: null })
    expect(f.host.capture('file', quote)?.defaultId).toBeNull()
    f.targets.pop()
    expect(f.host.capture('file', quote)?.defaultId).toBe('a')
  })

  it.each(['rebound', 'closed'])('rejects a %s target change instead of rerouting', (change) => {
    const f = fixture()
    const request = f.host.capture('file', quote)!
    if (change === 'closed')
      f.targets.shift()
    else f.targets[0]!.identity += change
    expect(f.host.add(request, 'a')).toBe('unavailable')
    expect(f.write).not.toHaveBeenCalled()
  })

  it.each([null, { identity: 'different-page', owner: 'task:b' }])('rejects a closed or rebound source', (source) => {
    const f = fixture()
    const request = f.host.capture('file', quote)!
    f.source(source)
    expect(f.host.add(request, 'a')).toBe('unavailable')
    expect(f.write).not.toHaveBeenCalled()
  })

  it('deduplicates views of the same real draft, but not different drafts with matching labels', () => {
    const f = fixture()
    f.targets.push({ ...f.targets[0]!, id: 'a-second-view' })
    expect(f.host.capture('file', quote)?.targets).toHaveLength(2)
    f.targets[1]!.label = 'Pane a'
    expect(f.host.capture('file', quote)?.targets).toHaveLength(2)
  })
})

describe('selection reference provider lifecycle', () => {
  afterEach(() => vi.useRealTimers())

  it('invalidates captured scopes on replacement even when the provider returns the same source identity', () => {
    const f = fixture()
    const request = f.host.capture('file', quote)!
    const unregister = f.host.registerProvider('test', { captureSource: () => ({ identity: 'file:source:1', owner: 'task:a' }) })
    f.unregister()
    expect(f.host.add(request, 'a')).toBe('unavailable')
    const replacement = f.host.capture('file', quote)!
    expect(replacement.defaultId).toBe('a')
    expect(f.host.add(replacement, 'a')).toBe('added')
    unregister()
    expect(f.host.isSourceCurrent(replacement)).toBe(false)
    expect(f.host.captureSource('file')).toBeNull()
  })

  it('allows a provider to decline a locator without falling back after an accepted handler fails', async () => {
    const f = fixture()
    const sourceOnly = f.host.registerProvider('source-only', { captureSource: () => null })
    expect(await f.host.locate(quote)).toBe(true)
    const reject = f.host.registerProvider('reject', { resolveLocate: () => async () => false })
    expect(await f.host.locate(quote)).toBe(false)
    reject()
    sourceOnly()
    expect(await f.host.locate(quote)).toBe(true)
    f.host.dispose()
  })

  it.each(['replacement', 'unregister', 'supersede', 'dispose'] as const)('settles a pending request and fences late effects after %s', async (change) => {
    const f = fixture()
    const deferred = Promise.withResolvers<boolean>()
    let current!: () => boolean
    let applied = false
    let signal!: AbortSignal
    const unregister = f.host.registerProvider('pending', {
      resolveLocate: () => async (request) => {
        current = request.current
        signal = request.signal
        await deferred.promise
        if (!signal.aborted)
          applied = true
        return true
      },
    })
    const pending = f.host.locate(quote)
    expect(current()).toBe(true)
    if (change === 'replacement')
      f.host.registerProvider('pending', { resolveLocate: () => async () => true })
    if (change === 'unregister')
      unregister()
    if (change === 'supersede') {
      f.host.registerProvider('next', { resolveLocate: () => async () => true })
      expect(await f.host.locate(quote)).toBe(true)
    }
    if (change === 'dispose')
      f.host.dispose()
    expect(await pending).toBe(false)
    expect(current()).toBe(false)
    expect(signal.aborted).toBe(true)
    deferred.resolve(true)
    await nextTick()
    expect(applied).toBe(false)
    if (change === 'dispose') {
      f.host.registerProvider('late', { captureSource: () => ({ identity: 'late', owner: null }) })
      expect(f.host.captureSource('file')).toBeNull()
      expect(f.host.targets()).toEqual([])
      expect(await f.host.locate(quote)).toBe(false)
    }
    f.host.dispose()
  })

  it('aborts pending provider work when the captured navigation scope changes', async () => {
    const version = shallowRef(0)
    const host = new WorkbenchSelectionReferences({ targets: () => [], captureLocateScope: () => {
      const captured = version.value
      return () => captured === version.value
    } })
    let signal!: AbortSignal
    const gate = Promise.withResolvers<boolean>()
    host.registerProvider('test', { resolveLocate: () => async (request) => {
      signal = request.signal
      return gate.promise
    } })
    const pending = host.locate(quote)
    version.value++
    expect(signal.aborted).toBe(true)
    expect(await pending).toBe(false)
    gate.resolve(true)
    host.dispose()
  })

  it('bounds a hanging handler and invalidates its reveal capability on timeout', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let current!: () => boolean
    const deferred = Promise.withResolvers<boolean>()
    f.host.registerProvider('slow', { resolveLocate: () => async (request) => {
      current = request.current
      return deferred.promise
    } })
    const pending = f.host.locate(quote)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toBe(false)
    expect(current()).toBe(false)
    deferred.resolve(true)
    f.host.dispose()
  })

  it('rejects a stale reveal registration and preserves its replacement after old cleanup', async () => {
    const f = fixture()
    const deferred = Promise.withResolvers<boolean>()
    let current!: () => boolean
    const unregister = f.host.registerReveal('view', async (_quote, active) => {
      current = active
      return deferred.promise
    })
    const pending = f.host.reveal('view', quote, () => true)
    await nextTick()
    f.host.registerReveal('view', async () => true)
    unregister()
    expect(current()).toBe(false)
    deferred.resolve(true)
    expect(await pending).toBe(false)
    expect(await f.host.reveal('view', quote, () => true)).toBe(true)
    f.host.dispose()
  })
})

it.each(['page', 'another-page'])('only accepts the exact page navigation requested by the active reference: %s', async (destination) => {
  const route = shallowRef('tasks')
  const host = new WorkbenchSelectionReferences({ targets: () => [], captureLocateScope: () => {
    const captured = route.value
    return () => route.value === captured
  } })
  let signal: AbortSignal | undefined
  host.registerProvider('page', { resolveLocate: () => async (request) => {
    signal = request.signal
    return request.navigate(async () => {
      route.value = destination
      await nextTick()
      return route.value === 'page'
    }, () => ['tasks', 'page'].includes(route.value))
  } })
  expect(await host.locate(quote)).toBe(destination === 'page')
  expect(signal?.aborted).toBe(true)
  host.dispose()
})

it('resumes scope cancellation after an authorized page navigation completes', async () => {
  const scope = shallowRef('tasks')
  const host = new WorkbenchSelectionReferences({ targets: () => [], captureLocateScope: () => {
    const captured = scope.value
    return () => scope.value === captured
  } })
  const arrived = Promise.withResolvers<void>()
  const waiting = Promise.withResolvers<boolean>()
  let signal: AbortSignal | undefined
  host.registerProvider('page', { resolveLocate: () => async (request) => {
    signal = request.signal
    if (!await request.navigate(async () => {
      scope.value = 'page'
      return true
    }, () => ['tasks', 'page'].includes(scope.value))) {
      return false
    }
    arrived.resolve()
    return waiting.promise
  } })
  const pending = host.locate(quote)
  await arrived.promise
  scope.value = 'user-selected-another-resource'
  expect(signal?.aborted).toBe(true)
  expect(await pending).toBe(false)
  waiting.resolve(true)
  host.dispose()
})

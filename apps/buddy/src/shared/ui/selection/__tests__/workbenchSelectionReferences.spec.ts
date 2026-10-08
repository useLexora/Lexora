import type { BuddyResourceQuote, BuddyUserContentV1 } from '@buddy-shared/conversation/buddyUserContent'
import type { SelectionReferenceSource, SelectionReferenceTarget } from '../workbenchSelectionReferences'
import { createBuddyUserContent } from '@buddy-shared/conversation/buddyUserContent'
import { describe, expect, it, vi } from 'vitest'
import { WorkbenchSelectionReferences } from '../workbenchSelectionReferences'

const quote: BuddyResourceQuote = { id: 'q', text: 'selected snapshot', source: { kind: 'file', title: 'notes.md', file: { spaceId: 's', directoryId: 'd', revision: 1, path: 'notes.md' }, format: 'markdown' }, textOffset: 3 }
function fixture() {
  const content = new Map<string, BuddyUserContentV1>([['a', createBuddyUserContent('A')], ['b', createBuddyUserContent('B')]])
  const write = vi.fn((id: string, value: BuddyUserContentV1) => content.set(id, value))
  const targets: SelectionReferenceTarget[] = ['a', 'b'].map(id => ({ id, identity: `${id}:draft:branch:epoch`, scope: `task:${id}`, label: `Pane ${id}`, read: () => content.get(id)!, write: value => write(id, value) }))
  let source: SelectionReferenceSource | null = { identity: 'file:source:1', owner: 'task:a' }
  const host = new WorkbenchSelectionReferences({ targets: () => targets, source: () => source, locate: async () => true })
  return { content, targets, write, host, source: (value: SelectionReferenceSource | null) => source = value }
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
    expect(f.content.get('b')?.body).toEqual(createBuddyUserContent('B typed after menu opened').body)
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

  it('does not silently fallback when the associated target is closed', () => {
    const f = fixture()
    f.targets.shift()
    expect(f.host.capture('file', quote)?.defaultId).toBeNull()
  })

  it.each(['branch', 'draft', 'sent', 'closed'])('rejects a %s target change instead of rerouting', (change) => {
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

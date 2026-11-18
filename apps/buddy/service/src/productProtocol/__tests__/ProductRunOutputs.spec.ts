import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { PRODUCT_QUERY_METHODS } from '../../../../shared/productProtocol/queries'
import { RunEventProjector } from '../../events/RunEventProjector'
import { createExecutionStorageFixture } from '../../storage/__tests__/executionFixture'
import { createArtifactRepository } from '../../storage/artifactRepository'
import { openBuddyMigrationCandidate } from '../../storage/database'
import { ProductQueries } from '../ProductQueries'

const databases: DatabaseSync[] = []
afterEach(() => databases.splice(0).forEach(database => database.close()))

function fixture() {
  const f = createExecutionStorageFixture(':memory:', openBuddyMigrationCandidate({ databasePath: ':memory:' }))
  databases.push(f.database)
  f.database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  const now = '2026-11-17T00:00:00.000Z'
  const artifacts = createArtifactRepository(f.database)
  const projector = new RunEventProjector(f.database)
  const sequences = new Map<string, number>()
  function output(runId: string, ids: string[]) {
    for (const id of ids) artifacts.save({ id, conversationId: 'conversation', currentPath: `/fixture/${id}.png`, directoryRoot: '/fixture', directoryGrantId: 'conversation', relativePath: `${id}.png`, kind: 'file', name: `${id}.png`, mimeType: 'image/png', sizeBytes: 120, sourceArtifactId: null, createdAt: now, updatedAt: now })
    const sequence = (sequences.get(runId) ?? 0) + 1
    sequences.set(runId, sequence)
    projector.project([{ runId, sequence, createdAt: now, type: 'output.produced', payload: { artifactIds: ids, sourceToolCallId: 'publish', sourceToolName: 'lexora_output_present' } }])
  }
  const queries = new ProductQueries(f.database, 'desktop-local', 'instance')
  const method = PRODUCT_QUERY_METHODS['runs.listOutputs']
  function read(runId: string, branchId = 'branch', cursor: string | null = null, limit = 100) {
    const input = method.input.parse({ runId, branchId, cursor, limit })
    return method.output.parse(queries.read('runs.listOutputs', input as Record<string, unknown>)) as { items: Array<{ resourceId: string }>, nextCursor: string | null }
  }
  return { ...f, output, read, now }
}

describe('public run output resources', () => {
  it('paginates published root and actor artifacts without paths or private child outputs', () => {
    const f = fixture()
    f.executions.admitChild(f.child('actor', f.actor.id))
    f.executions.admitChild(f.child('private'))
    f.output('root', ['one', 'two', 'three'])
    f.output('actor', ['actor-output'])
    f.output('private', ['private-output'])
    const first = f.read('root', 'branch', null, 2)
    expect(first.items.map(item => item.resourceId)).toEqual(['artifact:one', 'artifact:two'])
    expect(first.nextCursor).not.toBeNull()
    expect(f.read('root', 'branch', first.nextCursor, 2).items.map(item => item.resourceId)).toEqual(['artifact:three'])
    expect(f.read('actor').items.map(item => item.resourceId)).toEqual(['artifact:actor-output'])
    expect(f.read('private')).toEqual({ items: [], nextCursor: null })
    expect(JSON.stringify(first)).not.toContain('/fixture')
  })

  it('respects historical fork boundaries, unrelated branches, cursor revisions and task deletion', () => {
    const f = fixture()
    f.output('root', ['before'])
    f.conversations.createMessage({ id: 'cut', conversationId: 'conversation', branchId: 'branch', runId: 'root', role: 'assistant', content: { text: 'First result' }, createdAt: f.now })
    f.conversations.createBranch({ id: 'fork', conversationId: 'conversation', parentBranchId: 'branch', forkedFromMessageId: 'cut', createdAt: f.now, activate: false })
    f.output('root', ['after'])
    expect(f.read('root', 'fork').items.map(item => item.resourceId)).toEqual(['artifact:before'])
    expect(f.read('root').items).toHaveLength(2)
    const page = f.read('root', 'branch', null, 1)
    f.output('root', ['new'])
    expect(() => f.read('root', 'branch', page.nextCursor, 1)).toThrow('CURSOR_EXPIRED')
    f.conversations.createBranch({ id: 'independent', conversationId: 'conversation', parentBranchId: null, forkedFromMessageId: null, createdAt: f.now, activate: false })
    expect(f.read('root', 'independent').items).toEqual([])
    expect(() => f.read('root', 'missing')).toThrow('OBJECT_DELETED')
    f.database.prepare('UPDATE conversations SET deleted_at = ? WHERE id = ?').run(f.now, 'conversation')
    expect(f.read('root').items).toEqual([])
  })
})

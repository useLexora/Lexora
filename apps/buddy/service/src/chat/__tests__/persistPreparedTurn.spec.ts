import type { TurnRequestRecord } from '../../storage/turnRequestRepository'
import type { PreparedTurnAttachments } from '../persistPreparedTurn'
import { describe, expect, it } from 'vitest'
import { persistPreparedTurn } from '../persistPreparedTurn'

describe('persistPreparedTurn', () => {
  it('commits the winning request and rolls back an unreferenced staged copy', async () => {
    let winningState = 'staged'
    const winning = await persistPreparedTurn(attachments({
      commit: () => { winningState = 'committed' },
      rollback: () => { winningState = 'rolled-back' },
    }), () => request(true))

    let losingState = 'staged'
    const losing = await persistPreparedTurn(attachments({
      commit: () => { losingState = 'committed' },
      rollback: () => { losingState = 'rolled-back' },
    }), () => request(false))

    expect(winning.created).toBe(true)
    expect(winningState).toBe('committed')
    expect(losing.created).toBe(false)
    expect(losingState).toBe('rolled-back')
  })

  it('rolls back staged files when product persistence fails', async () => {
    let state = 'staged'
    await expect(persistPreparedTurn(attachments({
      commit: () => { state = 'committed' },
      rollback: () => { state = 'rolled-back' },
    }), () => {
      throw new Error('persistence failed')
    })).rejects.toThrow('persistence failed')

    expect(state).toBe('rolled-back')
  })
})

function attachments(options: {
  commit: () => void
  rollback: () => void
}): PreparedTurnAttachments {
  return {
    bindings: [],
    validate: () => {},
    commit: async () => options.commit(),
    rollback: async () => options.rollback(),
  }
}

function request(created: boolean): TurnRequestRecord {
  return {
    branchId: 'branch-1',
    conversationId: 'conversation-1',
    created,
    draftReceipt: null,
    requestFingerprint: 'fingerprint-1',
    requestId: 'request-1',
    runId: 'run-1',
  }
}

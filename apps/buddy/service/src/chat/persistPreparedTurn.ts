import type { PreparedMessageAttachments } from '../attachments/AttachmentService'
import type { PreparedComposerInput } from '../attachments/ComposerResourceService'
import type { TurnRequestRecord } from '../storage/turnRequestRepository'

export interface PreparedTurnAttachments extends PreparedMessageAttachments {
  validate: () => void
}

export function combinePreparedAttachments(attachments: PreparedMessageAttachments, resources: PreparedComposerInput): PreparedTurnAttachments {
  const settle = async (outcome: 'commit' | 'rollback') => {
    const failures: unknown[] = []
    for (const receipt of [attachments, resources]) {
      try {
        await receipt[outcome]()
      }
      catch (error) { failures.push(error) }
    }
    if (failures.length)
      throw new AggregateError(failures, 'TURN_ATTACHMENT_CLEANUP_FAILED')
  }
  return Object.freeze({ bindings: attachments.bindings, validate: resources.validate, commit: () => settle('commit'), rollback: () => settle('rollback') })
}

export async function persistPreparedTurn(
  attachments: PreparedTurnAttachments | null,
  persist: () => TurnRequestRecord,
): Promise<TurnRequestRecord> {
  let prepared: TurnRequestRecord
  try {
    attachments?.validate()
    prepared = persist()
  }
  catch (error) {
    await attachments?.rollback()
    throw error
  }
  if (prepared.created)
    await attachments?.commit().catch(() => undefined)
  else
    await attachments?.rollback().catch(() => undefined)
  return prepared
}

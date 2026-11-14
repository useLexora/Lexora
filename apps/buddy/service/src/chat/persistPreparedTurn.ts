import type { PreparedMessageAttachments } from '../attachments/AttachmentService'
import type { PreparedComposerInput } from '../attachments/ComposerResourceService'
import type { TurnRequestRecord } from '../storage/turnRequestRepository'
import { PreparedResourceSettlement } from './PreparedResourceSettlement'

export interface PreparedTurnAttachments extends PreparedMessageAttachments {
  validate: () => void
}

export function combinePreparedAttachments(attachments: PreparedMessageAttachments, resources: PreparedComposerInput): PreparedTurnAttachments {
  const settle = async (outcome: 'commit' | 'rollback' | 'retain') => {
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
  return Object.freeze({ bindings: attachments.bindings, validate: resources.validate, commit: () => settle('commit'), rollback: () => settle('rollback'), retain: () => settle('retain') })
}

export async function persistPreparedTurn(
  attachments: PreparedTurnAttachments | null,
  persist: () => TurnRequestRecord,
): Promise<TurnRequestRecord> {
  const resources = new PreparedResourceSettlement(attachments)
  let prepared: TurnRequestRecord
  try {
    attachments?.validate()
    prepared = persist()
  }
  catch (error) {
    await resources.fail(error)
    throw error
  }
  if (prepared.created)
    await resources.commit()
  else
    await resources.rollback()
  return prepared
}

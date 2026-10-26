import type { BuddyDefinitionResolver } from '../../../buddies/BuddyDefinitionResolver'
import type { RunInputRepository } from '../../../storage/runInputRepository'
import type { RunRecord } from '../../../storage/runRecord'
import type { RunRepository } from '../../../storage/runRepository'
import { BuddyAgentRunError } from '../../../runs/runError'

export async function recoverRunActorSnapshot(run: RunRecord, options: {
  definitions: Pick<BuddyDefinitionResolver, 'resolve' | 'resolveSnapshotIdentity'>
  runInputs: Pick<RunInputRepository, 'findByRunId'>
  runs: Pick<RunRepository, 'setActorSnapshot'>
}) {
  if (run.actorSnapshot)
    return options.definitions.resolveSnapshotIdentity(run.actorSnapshot)
  if (run.purpose === 'conversation.compaction')
    return undefined
  const stored = options.runInputs.findByRunId(run.id)
  const { definition } = await options.definitions.resolve({
    buddyId: run.buddyId,
    kind: 'actor',
    conversationId: run.conversationId,
    requestedModel: { providerId: run.provider, modelId: run.model, reasoning: stored?.reasoning ?? null, serviceTier: stored?.serviceTier ?? null },
  })
  if (!options.runs.setActorSnapshot(run.id, definition))
    throw new BuddyAgentRunError('RUN_STATE_MISMATCH')
  return definition
}

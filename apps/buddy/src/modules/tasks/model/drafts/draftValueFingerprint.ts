import type { BuddyComposerDraft } from '@buddy-shared/conversation/composerDraft'

type DraftValue = Pick<BuddyComposerDraft, 'content' | 'executionConfig' | 'modelSelection' | 'participants'>

export function createDraftValueFingerprint(value: DraftValue): string {
  const selection = value.modelSelection
  return JSON.stringify({
    content: value.content,
    participants: value.participants ?? null,
    executionConfig: {
      approvalPolicy: value.executionConfig.approvalPolicy,
      executionProfile: value.executionConfig.executionProfile,
    },
    modelSelection: selection
      ? {
          modelId: selection.modelId,
          providerId: selection.providerId,
          reasoning: selection.reasoning,
          serviceTier: selection.serviceTier,
        }
      : null,
  })
}

import type { BuddyMaterializedSkill } from '../../skills/SkillService'
import type { PrepareTurnRequestInput } from '../../storage/turnRequestRepository'
import type { ChatTurnServiceOptions } from '../ChatTurnService'
import { describe, expect, it } from 'vitest'
import { ChatTurnService } from '../ChatTurnService'

const skills: BuddyMaterializedSkill[] = ['publisher-one.tables', 'publisher-two.tables'].map(id => ({
  name: 'tables:review',
  body: `Instructions from ${id}`,
  filePath: `/fixture/${id}/SKILL.md`,
  baseDirectory: `/fixture/${id}`,
  reference: { id, name: 'tables:review', revision: `revision-${id}` },
}))

function fixture() {
  const service = new ChatTurnService({
    definitions: { validateActors: () => {} },
    getDefaultBuddyId: () => 'default',
    skills: { materializeForSpace: async () => skills },
    attachments: { getInputMetadata: () => [] },
    inputValidation: { validate: async () => {} },
  } as unknown as ChatTurnServiceOptions)
  const input = {
    spaceId: null,
    conversationId: 'conversation',
    branchId: 'branch',
    model: 'model',
    provider: 'provider',
    draft: { draftId: 'draft' },
    runInput: { prompt: '', attachmentIds: [], contextItems: skills.map(skill => ({ kind: 'skill', value: skill.name, skill: skill.reference })) },
  } as unknown as PrepareTurnRequestInput
  return { service, input }
}

describe('prepared plugin skill references', () => {
  it('preserves both explicit source identities when invocation names match', async () => {
    const { service, input } = fixture()
    await service.validatePreparedInput(input)
    expect(input.runInput.contextItems.map(item => item.skill)).toEqual(skills.map(skill => skill.reference))
  })
})

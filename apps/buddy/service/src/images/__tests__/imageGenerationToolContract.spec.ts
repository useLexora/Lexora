import { describe, expect, it } from 'vitest'
import { toPublicRunEvent } from '../../../../shared/runs/publicRunEvent'
import { createImageGenerationToolPresentation, readImageGenerationToolDetails } from '../imageGenerationToolContract'

const output = { details: { artifactIds: ['result'], responseId: 'response' } }

describe('image generation presentation compatibility', () => {
  it('projects explicit ordered reference IDs into the existing image card format', () => {
    expect(createImageGenerationToolPresentation({
      toolName: 'lexora_image_generate',
      arguments: { prompt: 'Preserve image 1 and use the pose from image 2', outputPath: 'result.png', referenceIds: ['character', 'pose'] },
      result: output,
    })).toMatchObject({
      card: 'image',
      reference: { mode: 'resources', resourceIds: ['character', 'pose'] },
      artifactIds: ['result'],
      generatedCount: 1,
      status: 'completed',
    })
  })

  it('keeps retained result metadata in tool details while projecting only safe failure diagnostics', () => {
    const retainedOutputs = [{ path: '/owned-scratch/.image-generation/original.png', mimeType: 'image/png', sizeBytes: 100, sha256: 'a'.repeat(64) }]
    const result = { details: { artifactIds: [], code: 'IMAGE_GENERATION_FAILED', outcome: 'partial', diagnostic: { stage: 'publishing', fileErrorCode: 'EACCES' }, retainedOutputs } }
    expect(readImageGenerationToolDetails(result)).toMatchObject({ retainedOutputs })
    const presentation = createImageGenerationToolPresentation({ toolName: 'lexora_image_generate', arguments: { outputPath: 'output/image.png' }, result, isError: true })
    expect(presentation).toMatchObject({ status: 'partial', failure: { diagnostic: { stage: 'publishing', fileErrorCode: 'EACCES' } } })
    expect(JSON.stringify(presentation)).not.toContain(retainedOutputs[0]!.path)
    expect(readImageGenerationToolDetails({ details: { ...result.details, retainedOutputs: [{ ...retainedOutputs[0], sha256: 'invalid' }] } })).not.toHaveProperty('retainedOutputs')
  })

  it.each([{ mode: 'latest' }, { mode: 'resources', resourceIds: ['original', 'pose'] }])('reads stored image cards without reexecuting or rewriting their selection: %j', (reference) => {
    const presentation = {
      card: 'image',
      artifactIds: ['result'],
      description: null,
      generatedCount: 1,
      prompt: 'Edit the reference',
      reference,
      status: 'completed',
    }
    const historical = { createdAt: '2026-10-01T00:00:00.000Z', runId: 'run-1', sequence: 1, type: 'tool.completed', payload: { toolCallId: 'call-1', toolName: 'lexora_image_generate', isError: false, presentation } }
    expect(toPublicRunEvent(historical).payload.presentation).toEqual(presentation)
  })
})

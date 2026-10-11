import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { TSchema } from 'typebox'
import type { PetActionService } from './PetActionService'
import type { PetToolDetails } from './petToolContract'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { z } from 'zod'
import { PET_MACRO_IDS } from './petMacroCatalog'

import { PET_TOOLS } from './petToolContract'

const petToolInputSchema = z.object({
  macro: z.enum(PET_MACRO_IDS),
}).strict()

const petToolParameters = {
  additionalProperties: false,
  properties: {
    macro: { enum: [...PET_MACRO_IDS], type: 'string' },
  },
  required: ['macro'],
  type: 'object',
} as TSchema

export interface CreatePetToolOptions {
  getRunId?: () => string | undefined
  service: PetActionService
}

export function createPetTool(options: CreatePetToolOptions): ToolDefinition {
  return defineTool<TSchema, PetToolDetails>({
    description: 'Express a simple Lexora Buddy desktop companion action',
    execute: async (toolCallId, parameters) => {
      const parsed = petToolInputSchema.safeParse(parameters)
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: 'Lexora Buddy pet action input is invalid' }],
          details: { code: 'VALIDATION_FAILED', macro: 'invalid', status: 'failed' },
          isError: false,
        }
      }
      const result = await options.service.execute({
        macro: parsed.data.macro,
        runId: options.getRunId?.(),
        toolCallId,
      })
      return {
        content: [{
          type: 'text',
          text: result.status === 'completed'
            ? `Lexora Buddy pet action completed: ${parsed.data.macro}`
            : `Lexora Buddy pet action was not completed: ${parsed.data.macro}`,
        }],
        details: {
          ...('code' in result ? { code: result.code } : {}),
          macro: parsed.data.macro,
          status: result.status,
        },
        isError: false,
      }
    },
    label: 'Lexora Buddy pet',
    ...PET_TOOLS.act,
    parameters: petToolParameters,
  })
}

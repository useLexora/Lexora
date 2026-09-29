import type { Static, TSchema } from 'typebox'
import type { BuddyCapability } from '../agent/extensions/BuddyCapability'
import type { BuddyInProcessExtension } from '../agent/extensions/BuddyInProcessExtension'
import type { DirectoryGrant } from '../directories/resolveGrantedPath'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Check } from 'typebox/value'
import {
  classifyOutputPresentTool,
  OUTPUT_PRESENT_TOOL_NAME,
  outputPresentParameters,
  readOutputPresentToolDetails,
} from './artifactToolContract'

type OutputPresentParameters = Static<typeof outputPresentParameters>

export function createOutputPresentationCapability(options: CreateOutputPresentationExtensionOptions): BuddyCapability {
  return {
    extension: createOutputPresentationExtension(options),
    classify: classifyOutputPresentTool,
    disclosure: [{ source: { kind: 'builtin', id: 'output', title: 'Task outputs' }, exposure: 'direct', keywords: '产物 交付 输出 artifact output deliverable', tools: [{ name: OUTPUT_PRESENT_TOOL_NAME }] }],
  }
}

export interface CreateOutputPresentationExtensionOptions {
  getExecutionGrants?: (toolCallId: string) => readonly DirectoryGrant[]
  artifactService: {
    presentOutputs: (input: {
      conversationId: string
      cwd: string
      grants: readonly DirectoryGrant[]
      paths: readonly string[]
    }) => Promise<Array<{ id: string }>>
  }
  conversationId: string
  cwd: string
  getRunId: () => string | undefined
  grants: readonly DirectoryGrant[]
}

export function createOutputPresentationExtension(
  options: CreateOutputPresentationExtensionOptions,
): BuddyInProcessExtension {
  return {
    name: 'lexora-output-presentation',
    factory(pi) {
      pi.registerTool(defineTool<TSchema, { artifactIds: string[], code?: string }>({
        description: [
          'Declare existing files or directories as the user-facing outputs of the current task.',
          'Each path is an independent deliverable; include a directory only when the directory itself is what the user should receive.',
        ].join(' '),
        execute: async (toolCallId, parameters) => {
          if (!Check(outputPresentParameters, parameters) || !options.getRunId())
            return outputPresentFailure('VALIDATION_FAILED')
          try {
            const input = parameters as OutputPresentParameters
            const artifacts = await options.artifactService.presentOutputs({
              conversationId: options.conversationId,
              cwd: options.cwd,
              grants: options.getExecutionGrants?.(toolCallId) ?? options.grants,
              paths: input.paths,
            })
            const artifactIds = artifacts.map(artifact => artifact.id)
            return {
              content: [{
                text: JSON.stringify({ artifactIds, presentedCount: artifactIds.length }),
                type: 'text' as const,
              }],
              details: { artifactIds },
            }
          }
          catch (error) {
            return outputPresentFailure(readArtifactErrorCode(error))
          }
        },
        label: 'Present output',
        name: OUTPUT_PRESENT_TOOL_NAME,
        parameters: outputPresentParameters,
        promptGuidelines: [
          'After creating or updating user-facing deliverables with file or shell tools, call lexora_output_present with the exact files or directories the user should receive.',
          'Do not present supporting files merely because they changed. Present multiple files individually unless their containing directory is itself the requested deliverable.',
          'Do not call lexora_output_present for outputs already returned by dedicated generation tools such as lexora_image_generate or lexora_image_chroma_key.',
        ],
      }))
      pi.on('tool_result', (event) => {
        if (event.toolName !== OUTPUT_PRESENT_TOOL_NAME)
          return
        if (readOutputPresentToolDetails({ details: event.details })?.code)
          return { isError: true }
      })
    },
  }
}

function outputPresentFailure(code: string) {
  return {
    content: [{
      text: `Lexora Buddy could not present the output: ${code}`,
      type: 'text' as const,
    }],
    details: { artifactIds: [], code },
  }
}

function readArtifactErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)
    ? code
    : 'ARTIFACT_PRESENTATION_FAILED'
}

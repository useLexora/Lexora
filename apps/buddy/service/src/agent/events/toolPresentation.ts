import type { BuddyToolPresentation } from '../../../../shared/runs/runEventPresentation'
import type { BuddyRunOutputPayload } from '../../../../shared/runs/runOutput'
import type { CreateBuddyToolPresentationInput } from '../../events/toolPresentationSupport'
import { filePaths, relativeCanonicalPath } from '../../../../platform/filesystem/filePaths'
import { redactSensitiveText, redactShellCommand } from '../../../../shared/permissions/approvalReviewPayload'
import { createOutputPresentRunOutput } from '../../artifacts/artifactToolContract'
import { createAutomationToolPresentation } from '../../automations/automationToolContract'
import { createBrowserToolPresentation } from '../../browser/browserToolPresentation'
import { createMcpRunOutput, createMcpToolPresentation } from '../../connectors/mcp/mcpToolContract'
import {
  argumentNames,
  boundedToolPreview,
  MAX_TOOL_PRESENTATION_OUTPUT_LENGTH,
  readOptionalString,
  readRecord,
  readToolDetails,
  readToolOutput,
} from '../../events/toolPresentationSupport'
import {
  createImageGenerationRunOutput,
  createImageGenerationToolPresentation,
} from '../../images/imageGenerationToolContract'
import {
  createImageTransformRunOutput,
  createImageTransformToolPresentation,
} from '../../images/imageTransformToolContract'
import { createPetToolPresentation } from '../../pet/petToolContract'
import { createSystemToolPresentation } from '../../system/systemToolContract'
import { createWebToolPresentation } from '../../web/webToolPresentation'
import { TOOL_SEARCH_NAME } from '../extensions/discovery/toolDiscoveryContract'
import { isPiShellToolName } from '../extensions/piBuiltinTools'

export type { CreateBuddyToolPresentationInput } from '../../events/toolPresentationSupport'

export function createBuddyRunOutputs(
  input: CreateBuddyToolPresentationInput & { toolCallId: string },
): BuddyRunOutputPayload[] {
  const output = createImageGenerationRunOutput(input)
    ?? createImageTransformRunOutput(input)
    ?? createOutputPresentRunOutput(input)
    ?? createMcpRunOutput(input)
  return output ? [output] : []
}

export function createBuddyToolPresentation(
  input: CreateBuddyToolPresentationInput,
): BuddyToolPresentation {
  return createPiToolPresentation(input)
    ?? createWebToolPresentation(input)
    ?? createPetToolPresentation(input)
    ?? createImageGenerationToolPresentation(input)
    ?? createImageTransformToolPresentation(input)
    ?? createAutomationToolPresentation(input)
    ?? createBrowserToolPresentation(input)
    ?? createSystemToolPresentation(input)
    ?? createMcpToolPresentation(input)
    ?? createGenericToolPresentation(input)
}

function createPiToolPresentation(
  input: CreateBuddyToolPresentationInput,
): BuddyToolPresentation | null {
  const arguments_ = readRecord(input.arguments)
  const output = readToolOutput(input.result)
  const preview = boundedToolPreview(output)
  const description = readOptionalString(arguments_, 'description')

  if (isPiShellToolName(input.toolName) || input.toolName === 'lexora_host_shell') {
    return {
      card: 'terminal',
      command: redactShellCommand(readString(arguments_, 'command')),
      cwd: input.canonicalRoot
        ? '.'
        : displayOptionalPath(readOptionalString(arguments_, 'cwd'), input.canonicalRoot),
      description,
      exitCode: readExitCode(input.result, input.isError),
      signal: readSignal(input.result, input.isError),
      ...preview,
    }
  }
  if (input.toolName === 'read') {
    return {
      card: 'read',
      description,
      language: languageFromPath(readString(arguments_, 'path')),
      lineStart: readPositiveInteger(arguments_, 'offset') ?? 1,
      path: displayPath(readString(arguments_, 'path'), input.canonicalRoot),
      ...preview,
    }
  }
  if (input.toolName === 'write' || input.toolName === 'edit') {
    return {
      card: 'diff',
      description,
      diff: readDiff(input.result),
      firstChangedLine: readPositiveInteger(readToolDetails(input.result), 'firstChangedLine'),
      operation: input.toolName === 'write' ? 'created' : 'edited',
      path: displayPath(readString(arguments_, 'path'), input.canonicalRoot),
      ...preview,
    }
  }
  if (input.toolName === 'grep' || input.toolName === 'find' || input.toolName === 'ls') {
    return {
      card: 'search',
      description,
      glob: readOptionalString(arguments_, 'glob'),
      path: displayOptionalPath(readOptionalString(arguments_, 'path'), input.canonicalRoot),
      query: readOptionalString(arguments_, 'pattern') ?? '',
      ...preview,
    }
  }
  return null
}

function createGenericToolPresentation(
  input: CreateBuddyToolPresentationInput,
): Extract<BuddyToolPresentation, { card: 'generic' }> {
  const arguments_ = readRecord(input.arguments)
  if (input.toolName === TOOL_SEARCH_NAME) {
    const details = readToolDetails(input.result)
    const tools = Array.isArray(details?.tools) ? details.tools : []
    const names = tools.flatMap(tool => typeof tool?.name === 'string' ? [tool.name] : [])
    return {
      argumentNames: argumentNames(arguments_),
      card: 'generic',
      description: '查找可用工具',
      ...boundedToolPreview(names.length > 0 ? names.join('\n') : readToolOutput(input.result)),
    }
  }
  return {
    argumentNames: argumentNames(arguments_),
    card: 'generic',
    description: readOptionalString(arguments_, 'description'),
    ...boundedToolPreview(readToolOutput(input.result)),
  }
}

function readDiff(value: unknown): string | null {
  const diff = readOptionalString(readToolDetails(value), 'diff')
  return diff
    ? redactSensitiveText(diff).slice(0, MAX_TOOL_PRESENTATION_OUTPUT_LENGTH)
    : null
}

function readExitCode(value: unknown, isError: boolean | undefined): number | null {
  if (value === undefined)
    return null
  const structured = readRecord(readRecord(value)?.structuredContent)?.exit_code
  if (typeof structured === 'number' && Number.isSafeInteger(structured))
    return structured
  if (isError === false)
    return 0
  if (isError === undefined)
    return null
  const match = readToolOutput(value)?.match(/(?:^|\r?\n)Command exited with code (\d+)[\r\n]*$/)
  const code = match ? Number.parseInt(match[1]!, 10) : null
  return code !== null && Number.isSafeInteger(code) ? code : null
}

function readSignal(value: unknown, isError: boolean | undefined): string | null {
  if (isError !== true)
    return null
  const match = readToolOutput(value)
    ?.match(/(?:^|\r?\n)Command (?:terminated by signal|killed by) ([A-Z][A-Z0-9]+)[\r\n]*$/i)
  return match?.[1]?.toUpperCase() ?? null
}

function displayPath(path: string, canonicalRoot: string | undefined): string {
  if (!canonicalRoot)
    return path || '.'
  try {
    const absolutePath = filePaths.resolveInput(path, canonicalRoot)
    const child = relativeCanonicalPath(canonicalRoot, absolutePath)
    return child === null ? absolutePath : child.split(filePaths.path.sep).join('/') || '.'
  }
  catch {
    return path || '.'
  }
}

function displayOptionalPath(
  path: string | null,
  canonicalRoot: string | undefined,
): string | null {
  return path === null ? null : displayPath(path, canonicalRoot)
}

const LANGUAGE_BY_EXTENSION = new Map([
  ['css', 'css'],
  ['html', 'html'],
  ['js', 'javascript'],
  ['json', 'json'],
  ['md', 'markdown'],
  ['py', 'python'],
  ['rs', 'rust'],
  ['scss', 'scss'],
  ['ts', 'typescript'],
  ['tsx', 'tsx'],
  ['vue', 'vue'],
])

function languageFromPath(path: string): string | null {
  const extension = path.split('.').at(-1)?.toLowerCase()
  return extension ? LANGUAGE_BY_EXTENSION.get(extension) ?? null : null
}

function readPositiveInteger(
  value: Record<string, unknown> | null,
  key: string,
): number | null {
  const candidate = value?.[key]
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0
    ? candidate
    : null
}

function readString(value: Record<string, unknown> | null, key: string): string {
  return readOptionalString(value, key) ?? ''
}

import type { SettingsManager } from '@earendil-works/pi-coding-agent'
import type { BuddyApprovalPolicy } from '../../../../shared/permissions/approvalPolicy'
import type { BuddyExecutionProfile } from '../../../../shared/permissions/executionProfile'
import type { BuddyInputReferenceV1 } from '../context/BuddyInputReference'
import type { BuddyInProcessExtension } from '../extensions/BuddyInProcessExtension'
import type { BoundedContextFile } from './loadBoundedContextFiles'
import process from 'node:process'

import {
  DefaultResourceLoader,
  SettingsManager as PiSettingsManager,
} from '@earendil-works/pi-coding-agent'
import { SHELL_SANDBOX_EXTENSION } from '../../sandbox/shellCapability'
import { getPiShellToolName, PI_BUILTIN_TOOL_NAME_SET } from '../extensions/piBuiltinTools'
import { createReadFileExtension, READ_FILE_EXTENSION } from '../extensions/readFileExtension'
import { createSystemSectionsExtension } from '../extensions/systemSectionsExtension'
import { createBuddySystemPrompt } from './createBuddySystemPrompt'

export interface CreateBuddyResourceLoaderOptions {
  getPendingInput?: () => BuddyInputReferenceV1 | null
  approvedSkillPaths: readonly string[]
  agentDir: string
  approvalPolicy: BuddyApprovalPolicy
  boundedContextFiles: readonly BoundedContextFile[]
  cwd: string
  directoryContext: string
  executionProfile: BuddyExecutionProfile
  inProcessExtensions: readonly BuddyInProcessExtension[]
  platform?: NodeJS.Platform
  settingsManager?: SettingsManager
}

export function createBuddySettingsManager(): SettingsManager {
  return PiSettingsManager.inMemory({
    cacheWarming: 'off',
    enableAnalytics: false,
    enableInstallTelemetry: false,
    extensions: [],
    packages: [],
    prompts: [],
    skills: [],
    themes: [],
  }, { projectTrusted: false })
}

export async function createBuddyResourceLoader(
  options: CreateBuddyResourceLoaderOptions,
): Promise<DefaultResourceLoader> {
  validateInProcessExtensions(options.inProcessExtensions)
  const systemPrompt = createBuddySystemPrompt({
    approvalPolicy: options.approvalPolicy,
    directoryContext: options.directoryContext,
    executionProfile: options.executionProfile,
    platform: options.platform,
  })
  const loader = new DefaultResourceLoader({
    additionalExtensionPaths: [],
    additionalPromptTemplatePaths: [],
    additionalSkillPaths: [...options.approvedSkillPaths],
    additionalThemePaths: [],
    agentDir: options.agentDir,
    agentsFilesOverride: () => ({ agentsFiles: [...options.boundedContextFiles] }),
    appendSystemPromptOverride: () => [],
    cwd: options.cwd,
    extensionFactories: [createReadFileExtension(options.cwd), ...options.inProcessExtensions, createSystemSectionsExtension(options.getPendingInput)],
    noContextFiles: true,
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    settingsManager: options.settingsManager ?? createBuddySettingsManager(),
    systemPrompt,
    systemPromptOverride: () => systemPrompt,
  })
  await loader.reload()
  validateLoadedExtensions(loader)
  return loader
}

export class BuddyResourceLoadError extends Error {
  readonly code: 'BUDDY_EXTENSION_LOAD_FAILED' | 'UNTRUSTED_EXTENSION_LOADED'

  constructor(code: BuddyResourceLoadError['code']) {
    super('Lexora Buddy could not load its runtime resources')
    this.name = 'BuddyResourceLoadError'
    this.code = code
  }
}

function validateInProcessExtensions(extensions: readonly BuddyInProcessExtension[]): void {
  if (extensions.some(extension => !extension.name.startsWith('lexora-')))
    throw new BuddyResourceLoadError('UNTRUSTED_EXTENSION_LOADED')
}

function validateLoadedExtensions(loader: DefaultResourceLoader): void {
  const result = loader.getExtensions()
  const hasInvalidToolName = result.extensions.some(extension => (
    [...extension.tools.keys()].some(toolName => (
      (PI_BUILTIN_TOOL_NAME_SET.has(toolName)
        && !(toolName === getPiShellToolName(process.platform) && extension.path === `<inline:${SHELL_SANDBOX_EXTENSION}>`)
        && !(toolName === 'read' && extension.path === `<inline:${READ_FILE_EXTENSION}>`))
      || (!toolName.startsWith('lexora_') && !toolName.startsWith('mcp__') && !PI_BUILTIN_TOOL_NAME_SET.has(toolName))
    ))
  ))
  const hasInvalidToolSchema = result.extensions.some(extension => (
    [...extension.tools.values()].some(tool => !isObjectRootToolSchema(tool.definition.parameters))
  ))
  if (result.errors.length || hasInvalidToolName || hasInvalidToolSchema)
    throw new BuddyResourceLoadError('BUDDY_EXTENSION_LOAD_FAILED')
  if (result.extensions.some(extension => !extension.path.startsWith('<inline:lexora-')))
    throw new BuddyResourceLoadError('UNTRUSTED_EXTENSION_LOADED')
}

function isObjectRootToolSchema(schema: unknown): boolean {
  return typeof schema === 'object'
    && schema !== null
    && (schema as { type?: unknown }).type === 'object'
}

import type { SettingsManager } from '@earendil-works/pi-coding-agent'
import type { BuddyApprovalPolicy } from '../../../../shared/permissions/approvalPolicy'
import type { BuddyExecutionProfile } from '../../../../shared/permissions/executionProfile'
import type { BuddyPermissionSettings } from '../../../../shared/permissions/permissionMode'
import type { LocalSkill } from '../../../../shared/skills/skillApi'
import type { BuddyInputReferenceV1 } from '../context/BuddyInputReference'
import type { BuddyInProcessExtension } from '../extensions/BuddyInProcessExtension'
import type { BoundedContextFile } from './loadBoundedContextFiles'
import { dirname } from 'node:path'
import process from 'node:process'

import {
  DefaultResourceLoader,
  SettingsManager as PiSettingsManager,
} from '@earendil-works/pi-coding-agent'
import { DEFAULT_MODEL_RETRY_LIMIT } from '../../../../shared/runtime/runtimePreferences'
import { skillInvocationName } from '../../../../shared/skills/skillApi'
import { SHELL_SANDBOX_EXTENSION } from '../../sandbox/shellCapability'
import { CODEMODE_EXTENSION, CODEMODE_TOOL_NAME } from '../extensions/codemodeExtension'
import { FILE_MUTATION_EXTENSION } from '../extensions/fileMutationExtension'
import { getPiShellToolName, PI_BUILTIN_TOOL_NAME_SET } from '../extensions/piBuiltinTools'
import { createReadFileExtension, READ_FILE_EXTENSION } from '../extensions/readFileExtension'
import { createSystemSectionsExtension } from '../extensions/systemSectionsExtension'
import { BUDDY_MANUAL_APPROVAL_PROMPT, createBuddyExecutionPrompt, createBuddySystemPrompt } from './createBuddySystemPrompt'

export interface CreateBuddyResourceLoaderOptions {
  actorPrompt?: string
  getPermissionSettings?: () => BuddyPermissionSettings
  getPendingInput?: () => BuddyInputReferenceV1 | null
  approvedSkills: readonly LocalSkill[]
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
    retry: {
      enabled: true,
      maxRetries: DEFAULT_MODEL_RETRY_LIMIT,
      baseDelayMs: 2_000,
      maxAgentDelayMs: 60_000,
      provider: { maxRetries: 0 },
    },
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
    includePermissions: false,
  })
  const loader = new DefaultResourceLoader({
    additionalExtensionPaths: [],
    additionalPromptTemplatePaths: [],
    additionalSkillPaths: [],
    additionalThemePaths: [],
    agentDir: options.agentDir,
    agentsFilesOverride: () => ({ agentsFiles: [...options.boundedContextFiles] }),
    appendSystemPromptOverride: () => [],
    cwd: options.cwd,
    extensionFactories: [createReadFileExtension(options.cwd), ...options.inProcessExtensions, createSystemSectionsExtension(options.getPendingInput, toolNames => createPermissionPrompt(options.getPermissionSettings?.() ?? options, options.platform, toolNames), () => options.actorPrompt ?? '')],
    noContextFiles: true,
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    skillsOverride: () => ({
      skills: options.approvedSkills.map(skill => ({
        name: skillInvocationName(skill),
        description: skill.description,
        filePath: skill.filePath,
        baseDir: dirname(skill.filePath),
        disableModelInvocation: skill.status === 'manual_only',
        sourceInfo: {
          path: skill.filePath,
          source: 'lexora',
          scope: skill.source === 'directory' ? 'project' : 'user',
          origin: 'top-level',
        },
      })),
      diagnostics: [],
    }),
    noThemes: true,
    settingsManager: options.settingsManager ?? createBuddySettingsManager(),
    systemPrompt,
    systemPromptOverride: () => systemPrompt,
  })
  await loader.reload()
  validateLoadedExtensions(loader)
  return loader
}

export function createPermissionPrompt(settings: BuddyPermissionSettings, platform?: NodeJS.Platform, activeToolNames?: readonly string[]): string {
  return [createBuddyExecutionPrompt(settings.executionProfile, platform, activeToolNames), ...settings.executionProfile !== 'full_access' && settings.approvalPolicy === 'manual' ? [BUDDY_MANUAL_APPROVAL_PROMPT] : []].join('\n\n')
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
        && !(toolName === 'read' && extension.path === `<inline:${READ_FILE_EXTENSION}>`)
        && !((toolName === 'write' || toolName === 'edit') && extension.path === `<inline:${FILE_MUTATION_EXTENSION}>`))
      || (!toolName.startsWith('lexora_') && !toolName.startsWith('mcp__') && !PI_BUILTIN_TOOL_NAME_SET.has(toolName)
        && !(toolName === CODEMODE_TOOL_NAME && extension.path === `<inline:${CODEMODE_EXTENSION}>`))
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

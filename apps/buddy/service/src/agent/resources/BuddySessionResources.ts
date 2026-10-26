import type { LocalSkill, SkillReference } from '../../../../shared/skills/skillApi'
import type { BuddyExecutionDefinition } from '../../buddies/BuddyExecutionDefinition'
import type { SkillService } from '../../skills/SkillService'
import type { ExecutionKind } from '../../storage/runRecord'
import type { BoundedContextFilesResult } from './loadBoundedContextFiles'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { SkillError } from '../../skills/skillFiles'
import { formatBuddySkillPrompt } from '../../skills/SkillService'

import { loadBoundedContextFiles } from './loadBoundedContextFiles'

export interface BuddySessionResources {
  actorPrompt?: string
  availableSkillReferences?: readonly SkillReference[]
  approvedSkills: readonly LocalSkill[]
  skillReadRoots: readonly string[]
  skillReferences: readonly SkillReference[]
  context: BoundedContextFilesResult
  directoryContext: string
  revision: string
  skillRevision?: string
}

export interface ResolveBuddySessionResourcesOptions {
  contextMode?: 'execution' | 'compaction'
  actor?: BuddyExecutionDefinition
  executionKind?: ExecutionKind
  additionalDirectories: readonly {
    canonicalRoot: string
  }[]
  canonicalRoot: string
  cwd: string
  loadDirectoryContext: boolean
  primaryDirectory: { canonicalRoot: string } | null
  spaceId: string | null
  skills: Pick<SkillService, 'loadForSpace' | 'materializeForSpace'>
}

export async function resolveBuddySessionResources(
  options: ResolveBuddySessionResourcesOptions,
): Promise<BuddySessionResources> {
  const [skills, context] = await Promise.all([
    options.skills.loadForSpace(options.spaceId),
    options.loadDirectoryContext
      ? loadBoundedContextFiles({
          canonicalRoot: options.canonicalRoot,
          cwd: options.cwd,
        })
      : Promise.resolve({ agentsFiles: [], diagnostics: [] }),
  ])
  const actor = options.contextMode === 'compaction' ? undefined : options.actor
  const scope = options.contextMode === 'compaction' ? { mode: 'none' as const } : actor?.settings.skills ?? { mode: 'all' as const }
  const approvedSkills = skills.skills.filter(skill => scope.mode === 'all' || (scope.mode === 'selected' && scope.ids.includes(skill.id)))
  const approvedIds = new Set(approvedSkills.map(skill => skill.id))
  const skillReferences = skills.references.filter(skill => approvedIds.has(skill.id))
  const requiredIds = actor?.settings.requiredSkills ?? []
  const requiredReferences = requiredIds.map((id) => {
    const reference = skillReferences.find(skill => skill.id === id)
    if (!reference)
      throw new SkillError('SKILL_NOT_FOUND')
    return reference
  })
  const required = requiredReferences.length ? await options.skills.materializeForSpace(options.spaceId, requiredReferences) : []
  const actorPrompt = [createActorPrompt(actor, options.executionKind), ...required.map(formatBuddySkillPrompt)].filter(Boolean).join('\n\n')
  const hash = createHash('sha256')
  hash.update(options.contextMode ?? 'execution')
  hash.update(JSON.stringify(skillReferences))
  hash.update(actorPrompt)
  const directoryContext = createDirectoryContext(
    options.cwd,
    options.primaryDirectory,
    options.additionalDirectories,
  )
  hash.update(skills.revision)
  hash.update('\0')
  hash.update(directoryContext)
  hash.update('\0')
  for (const file of context.agentsFiles) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.content)
    hash.update('\0')
  }
  return {
    actorPrompt,
    approvedSkills,
    skillReadRoots: [...new Set(approvedSkills.map(skill => dirname(skill.filePath)))],
    skillReferences,
    availableSkillReferences: skills.references,
    context,
    directoryContext,
    revision: hash.digest('hex'),
    skillRevision: skills.revision,
  }
}

function createActorPrompt(actor: BuddyExecutionDefinition | undefined, executionKind: ExecutionKind = 'root'): string {
  if (!actor)
    return ''
  return [
    'Current execution identity:',
    `Buddy ID: ${JSON.stringify(actor.id)}`,
    ...(actor.name === undefined ? [] : [`Name: ${JSON.stringify(actor.name)}`]),
    `Definition kind: ${actor.kind}`,
    `Execution kind: ${executionKind}`,
    'This is your identity for this execution. Lexora is the host application; other partners are separate agents.',
    ...(executionKind === 'actor_child' || executionKind === 'npc_child'
      ? ['You have already accepted a delegated assignment. The incoming task is assigned to you. If it names you, do that work yourself; do not look for or delegate to another instance of yourself. Stay within the assigned scope.']
      : []),
    ...(executionKind === 'actor_child' ? ['Your replies are shown directly to the user under your own identity.'] : []),
    ...(actor.kind === 'npc' ? ['Your final reply is delivered to your caller. You cannot create child executions.'] : []),
    ...(actor.description ? [`Role background and responsibilities:\n${actor.description}`] : []),
    ...(actor.settings.instructions ? [`Action guidelines:\n${actor.settings.instructions}`] : []),
    'Your role background and action guidelines do not grant tools, permissions, or access beyond the current execution.',
  ].join('\n')
}

function createDirectoryContext(
  workingDirectory: string,
  primaryDirectory: ResolveBuddySessionResourcesOptions['primaryDirectory'],
  additionalDirectories: ResolveBuddySessionResourcesOptions['additionalDirectories'],
): string {
  return [
    `Working directory: ${workingDirectory}`,
    primaryDirectory
      ? `Primary Space directory: ${primaryDirectory.canonicalRoot}`
      : 'Primary Space directory: managed workspace.',
    ...(additionalDirectories.length > 0
      ? [
          'Additional authorized directories (access only; not preloaded as context):',
          ...additionalDirectories.map(directory => `- ${directory.canonicalRoot}`),
          'Inspect an additional directory only when the task requires files from it.',
        ]
      : ['Additional authorized directories: none.']),
  ].join('\n')
}

import type { LocalSkill, SkillReference } from '../../../../shared/skills/skillApi'
import type { SkillService } from '../../skills/SkillService'
import type { BoundedContextFilesResult } from './loadBoundedContextFiles'
import { createHash } from 'node:crypto'

import { loadBoundedContextFiles } from './loadBoundedContextFiles'

export interface BuddySessionResources {
  approvedSkills: readonly LocalSkill[]
  skillReadRoots: readonly string[]
  skillReferences: readonly SkillReference[]
  context: BoundedContextFilesResult
  directoryContext: string
  revision: string
  skillRevision?: string
}

export interface ResolveBuddySessionResourcesOptions {
  additionalDirectories: readonly {
    canonicalRoot: string
  }[]
  canonicalRoot: string
  cwd: string
  loadDirectoryContext: boolean
  primaryDirectory: { canonicalRoot: string } | null
  spaceId: string | null
  skills: Pick<SkillService, 'loadForSpace'>
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
  const hash = createHash('sha256')
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
    approvedSkills: skills.skills,
    skillReadRoots: skills.readRoots,
    skillReferences: skills.references,
    context,
    directoryContext,
    revision: hash.digest('hex'),
    skillRevision: skills.revision,
  }
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

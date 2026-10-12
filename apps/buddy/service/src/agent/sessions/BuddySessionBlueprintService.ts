import type { SpaceExecutionContext } from '../../../../shared/conversation/space'
import type { BuddyApprovalPolicy } from '../../../../shared/permissions/approvalPolicy'
import type { BuddyExecutionProfile } from '../../../../shared/permissions/executionProfile'
import type { BuddySessionMode } from '../../../../shared/permissions/sessionMode'
import type { BuddyExecutionDefinition } from '../../buddies/BuddyExecutionDefinition'
import type { DirectoryGrant } from '../../directories/resolveGrantedPath'
import type { SkillService } from '../../skills/SkillService'
import type { BuddyDataPaths } from '../../storage/BuddyDataPaths'
import type {
  ConversationDirectoryGrantRecord,
  ConversationDirectoryGrantRepository,
} from '../../storage/conversationDirectoryGrantRepository'
import type {
  SpaceAdditionalDirectoryBindingRecord,
  SpacePrimaryDirectoryBindingRecord,
  SpaceRecord,
  SpaceRepository,
} from '../../storage/spaceRepository'
import type { BuddySessionBlueprint } from './BuddySessionBlueprint'
import { createHash } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { BuddyAgentRunError } from '../../runs/runError'
import { requireActiveSpace } from '../../spaces/requireActiveSpace'
import {
  createSpaceExecutionContext,
  matchesSpaceExecutionContext,
} from '../../spaces/spaceExecutionContext'
import { resolveBuddySessionResources } from '../resources/BuddySessionResources'

export interface CreateConversationSessionBlueprintInput {
  threadId?: string
  contextMode?: 'execution' | 'compaction'
  actor?: BuddyExecutionDefinition
  approvalPolicy: BuddyApprovalPolicy
  branchId: string
  conversationId: string
  executionProfile: BuddyExecutionProfile
  executionContext?: SpaceExecutionContext | null
  sessionMode: BuddySessionMode
  spaceId: string | null
}

export interface CreateDraftSessionBlueprintInput {
  actor?: BuddyExecutionDefinition
  approvalPolicy: BuddyApprovalPolicy
  draftId: string
  executionProfile: BuddyExecutionProfile
  spaceId: string | null
}

export interface BuddySessionBlueprintServiceOptions {
  conversationGrants: Pick<ConversationDirectoryGrantRepository, 'listActive'>
  paths: Pick<BuddyDataPaths, 'conversationWorkspace' | 'draftAttachments' | 'spaceWorkspace'>
  skills: Pick<SkillService, 'loadForSpace' | 'materializeForSpace'>
  spaces: Pick<SpaceRepository, 'findById'>
}

export class BuddySessionBlueprintService {
  readonly #options: BuddySessionBlueprintServiceOptions

  constructor(options: BuddySessionBlueprintServiceOptions) {
    this.#options = options
  }

  createForConversation(
    input: CreateConversationSessionBlueprintInput,
  ): Promise<BuddySessionBlueprint> {
    return this.#create({
      ...input,
      conversationDirectories: input.spaceId
        ? []
        : this.#options.conversationGrants.listActive(input.conversationId),
      ownedRoot: input.spaceId
        ? this.#options.paths.spaceWorkspace(input.spaceId)
        : this.#options.paths.conversationWorkspace(input.conversationId),
    })
  }

  createForDraft(input: CreateDraftSessionBlueprintInput): Promise<BuddySessionBlueprint> {
    return this.#create({
      actor: input.actor,
      branchId: 'context-preview',
      approvalPolicy: input.approvalPolicy,
      conversationDirectories: [],
      conversationId: input.draftId,
      executionProfile: input.executionProfile,
      ownedRoot: input.spaceId
        ? this.#options.paths.spaceWorkspace(input.spaceId)
        : this.#options.paths.draftAttachments(input.draftId),
      sessionMode: 'interactive',
      spaceId: input.spaceId,
    })
  }

  async #create(input: CreateConversationSessionBlueprintInput & {
    conversationDirectories: readonly ConversationDirectoryGrantRecord[]
    ownedRoot: string
  }): Promise<BuddySessionBlueprint> {
    const space = input.spaceId
      ? requireActiveSpace(this.#options.spaces.findById(input.spaceId))
      : null
    if (
      input.executionContext
      && (!space || !matchesSpaceExecutionContext(space, input.executionContext))
    ) {
      throw new BuddyAgentRunError('DIRECTORY_NOT_AUTHORIZED')
    }
    const directories = space
      ? await resolveSpaceDirectories(space)
      : {
          additionalDirectories: await resolveConversationDirectories(
            input.conversationDirectories,
          ),
          primaryDirectory: null,
        }
    const primaryDirectory = directories.primaryDirectory
    const scratchRoot = await resolveOwnedRoot(input.ownedRoot)
    const canonicalRoot = primaryDirectory?.canonicalRoot ?? scratchRoot
    const workingGrants = primaryDirectory
      ? [
          toPrimaryDirectoryGrant(primaryDirectory),
          ...directories.additionalDirectories.map(toDirectoryGrant),
        ]
      : [
          toOwnedDirectoryGrant(canonicalRoot, space?.id ?? input.conversationId),
          ...directories.additionalDirectories.map(toDirectoryGrant),
        ]
    const grants = canonicalRoot === scratchRoot
      ? workingGrants
      : [
          ...workingGrants,
          toOwnedDirectoryGrant(scratchRoot, space?.id ?? input.conversationId),
        ]
    const resources = await resolveBuddySessionResources({
      contextMode: input.contextMode,
      actor: input.actor,
      additionalDirectories: directories.additionalDirectories,
      canonicalRoot,
      cwd: canonicalRoot,
      loadDirectoryContext: Boolean(primaryDirectory),
      primaryDirectory,
      skills: this.#options.skills,
      spaceId: space?.id ?? null,
    })
    const grantRevision = createGrantRevision(grants, [
      ...(primaryDirectory ? [primaryDirectory] : []),
      ...directories.additionalDirectories,
    ])

    return {
      threadId: input.threadId,
      actor: input.actor,
      approvalPolicy: input.approvalPolicy,
      branchId: input.branchId,
      canonicalRoot,
      conversationId: input.conversationId,
      executionProfile: input.executionProfile,
      grantRevision,
      grants,
      resources,
      scratchRoot,
      sessionMode: input.sessionMode,
      space: space
        ? (() => {
            const executionContext = createSpaceExecutionContext(space)
            return {
              additionalDirectoryBindings: executionContext.additionalDirectoryBindings,
              id: space.id,
              memoryScope: space.memoryScope,
              primaryDirectoryBinding: executionContext.primaryDirectoryBinding,
            }
          })()
        : null,
    }
  }
}

async function resolveSpaceDirectories(
  space: SpaceRecord,
): Promise<{
  additionalDirectories: SpaceAdditionalDirectoryBindingRecord[]
  primaryDirectory: SpacePrimaryDirectoryBindingRecord | null
}> {
  try {
    const resolveDirectory = async <Directory extends SpaceAdditionalDirectoryBindingRecord>(
      directory: Directory,
    ): Promise<Directory> => {
      const canonicalRoot = await realpath(directory.root)
      const metadata = await stat(canonicalRoot)
      if (canonicalRoot !== directory.canonicalRoot || !metadata.isDirectory())
        throw new Error('Space directory identity changed')
      return directory
    }
    const [primaryDirectory, additionalDirectories] = await Promise.all([
      space.primaryDirectory ? resolveDirectory(space.primaryDirectory) : null,
      Promise.all(space.additionalDirectories.map(resolveDirectory)),
    ])
    return { additionalDirectories, primaryDirectory }
  }
  catch {
    throw new BuddyAgentRunError('DIRECTORY_NOT_AUTHORIZED')
  }
}

async function resolveOwnedRoot(root: string): Promise<string> {
  await mkdir(root, { mode: 0o700, recursive: true })
  return realpath(root)
}

function toDirectoryGrant(directory: {
  canonicalRoot: string
  id: string
  root: string
}): DirectoryGrant {
  return {
    canonicalRoot: directory.canonicalRoot,
    grantId: directory.id,
    kind: 'granted',
    root: directory.root,
  }
}

function toPrimaryDirectoryGrant(directory: {
  canonicalRoot: string
  id: string
  root: string
}): DirectoryGrant {
  return { ...toDirectoryGrant(directory), kind: 'workspace' }
}

function toOwnedDirectoryGrant(root: string, ownerId: string): DirectoryGrant {
  return { canonicalRoot: root, grantId: ownerId, kind: 'workspace', root }
}

function createGrantRevision(
  grants: readonly DirectoryGrant[],
  directories: readonly { id: string, revision?: number }[],
): string {
  const revisions = new Map(directories.map(directory => [directory.id, directory.revision]))
  const hash = createHash('sha256')
  for (const grant of grants) {
    hash.update(grant.grantId)
    hash.update('\0')
    hash.update(grant.canonicalRoot)
    hash.update('\0')
    hash.update(String(revisions.get(grant.grantId) ?? 1))
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function resolveConversationDirectories(
  directories: readonly ConversationDirectoryGrantRecord[],
): Promise<ConversationDirectoryGrantRecord[]> {
  const resolved = await Promise.all(directories.map(async (directory) => {
    try {
      const canonicalRoot = await realpath(directory.root)
      const metadata = await stat(canonicalRoot)
      return canonicalRoot === directory.canonicalRoot && metadata.isDirectory()
        ? directory
        : null
    }
    catch {
      return null
    }
  }))
  return resolved.filter((directory): directory is ConversationDirectoryGrantRecord => (
    directory !== null
  ))
}

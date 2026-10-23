import type { TaskFileTarget } from '../../../shared/files/taskFileApi'
import type { BuddyDataPaths } from '../storage/BuddyDataPaths'
import type { ConversationDirectoryGrantRepository } from '../storage/conversationDirectoryGrantRepository'
import type { ConversationRepository } from '../storage/conversationRepository'
import type { SpaceRepository } from '../storage/spaceRepository'
import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { localFileLinkPath } from '../../../shared/files/fileLink'
import { resolveGrantedPath } from '../directories/resolveGrantedPath'
import { createSensitivePathMatcher } from '../permissions/sensitivePaths'
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { requireActiveSpace } from '../spaces/requireActiveSpace'

export interface TaskFileAccessOptions {
  conversations: Pick<ConversationRepository, 'findById'>
  conversationGrants: Pick<ConversationDirectoryGrantRepository, 'listActive'>
  spaces: Pick<SpaceRepository, 'findById'>
  paths: BuddyDataPaths
}

export class TaskFileAccess {
  private readonly options: TaskFileAccessOptions

  constructor(options: TaskFileAccessOptions) {
    this.options = options
  }

  async resolveLink(conversationId: string, href: string): Promise<{ root: string, path: string }> {
    const path = localFileLinkPath(href)
    if (!path)
      throw new BuddyServiceError('VALIDATION_FAILED')
    return this.resolvePath(conversationId, path, false)
  }

  async resolve(target: TaskFileTarget): Promise<{ root: string, path: string }> {
    if (!isAbsolute(target.path) || target.path.includes('\0'))
      throw new BuddyServiceError('VALIDATION_FAILED')
    return this.resolvePath(target.conversationId, target.path, true)
  }

  private async resolvePath(conversationId: string, path: string, canonical: boolean) {
    const directories = await this.directories(conversationId)
    const requestedPath = resolve(directories.cwd, path)
    const result = await resolveGrantedPath(directories.grants, requestedPath, 'existing')
    const sensitive = createSensitivePathMatcher()
    const grant = directories.grants.find(grant => grant.grantId === result.grantId)!
    if ((canonical && result.canonicalPath !== path)
      || sensitive.matches(grant.sourceRoot) || sensitive.matches(result.root)
      || sensitive.matches(requestedPath) || sensitive.matches(result.canonicalPath)
      || JSON.stringify(await this.directories(conversationId)) !== JSON.stringify(directories)) {
      throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
    }
    return { root: result.root, path: result.canonicalPath }
  }

  private async directories(conversationId: string) {
    const { conversations, conversationGrants, spaces, paths } = this.options
    const conversation = conversations.findById(conversationId)
    if (!conversation || conversation.deletedAt !== null)
      throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
    const space = conversation.spaceId ? requireActiveSpace(spaces.findById(conversation.spaceId)) : null
    const owned = space ? paths.spaceWorkspace(space.id) : paths.conversationWorkspace(conversation.id)
    const bindings = space
      ? [space.primaryDirectory, ...space.additionalDirectories].filter(binding => binding && !binding.revokedAt)
      : conversationGrants.listActive(conversation.id)
    const grants = (await Promise.all(bindings.map(async (binding) => {
      if (!binding || await realpath(binding.root).catch(() => null) !== binding.canonicalRoot)
        return null
      return { sourceRoot: binding.root, root: binding.canonicalRoot, canonicalRoot: binding.canonicalRoot, grantId: binding.id, kind: 'granted' as const, revision: 'revision' in binding ? binding.revision : undefined }
    }))).filter(grant => grant !== null)
    const canonicalRoot = await realpath(owned).catch(() => null)
    return {
      cwd: space?.primaryDirectory?.canonicalRoot ?? canonicalRoot ?? owned,
      grants: [...grants, ...(canonicalRoot ? [{ sourceRoot: owned, root: canonicalRoot, canonicalRoot, grantId: space?.id ?? conversation.id, kind: 'workspace' as const }] : [])],
    }
  }
}

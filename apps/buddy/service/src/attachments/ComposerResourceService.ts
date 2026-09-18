import type { BuddyUserContentV1, BuddyUserMessageResourceSnapshot } from '../../../shared/conversation/buddyUserContent'
import type {
  BuddyArtifactSource,
  BuddyComposerResource,
  BuddyComposerResourceAccept,
  BuddyComposerResourceComplete,
  BuddyComposerResourceTarget,
  BuddyComposerSource,
  BuddyComposerSourceList,
  BuddyComposerSourceListResponse,
  BuddyComposerSourceOption,
  BuddyComposerSourceOrigin,
  BuddyComposerSourceSelect,
  BuddyComposerSpaceFileSelect,
  BuddyLocalResourceOrigin,
  BuddyMessageInputSource,
  BuddyMessageResourceSource,
  BuddySpaceFileOrigin,
  BuddySpaceFileSource,
} from '../../../shared/conversation/composerResource'
import type { ArtifactResource, ArtifactService } from '../artifacts/ArtifactService'
import type { RunEventReader } from '../events/RunEventPorts'
import type { ResolvedInteractiveModelSelection } from '../providers/resolveInteractiveModelSelection'
import type { AttachmentRecord } from '../storage/attachmentRepository'
import type { BuddyDataPaths } from '../storage/BuddyDataPaths'
import type { ComposerDraftRepository } from '../storage/composerDraftRepository'
import type { ComposerResourceRecord, ComposerResourceRepository } from '../storage/composerResourceRepository'
import type { ConversationDirectoryGrantRepository } from '../storage/conversationDirectoryGrantRepository'
import type { ConversationRepository } from '../storage/conversationRepository'
import type { SpaceRepository } from '../storage/spaceRepository'
import type { AttachmentService } from './AttachmentService'
import { createHash, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { readBoundedFile } from '../../../platform/filesystem/boundedFile'
import { BUDDY_ATTACHMENT_COUNT_LIMIT, BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT, getAttachmentKind } from '../../../shared/conversation/attachmentPolicy'
import { getBuddyUserContentResourceIds, readBuddyUserMessageContent } from '../../../shared/conversation/buddyUserContent'
import { buddyComposerResourceAcceptSchema, buddyComposerSourceListSchema, buddyComposerSourceSelectSchema, buddyComposerSpaceFileSelectSchema } from '../../../shared/conversation/composerResource'
import { buddyRunOutputPayloadSchema } from '../../../shared/runs/runOutput'
import { resolveGrantedPath } from '../directories/resolveGrantedPath'
import { createSensitivePathMatcher } from '../permissions/sensitivePaths'
import { base64BytesLength, getModelRequestBytesLimit } from '../providers/modelInputBudget'
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { requireActiveSpace } from '../spaces/requireActiveSpace'
import { ComposerResourceConflictError } from '../storage/composerResourceRepository'
import { AttachmentError, DRAFT_ATTACHMENT_RETENTION_MS, normalizeAttachmentMetadata } from './AttachmentService'
import { ComposerDirectorySources } from './ComposerDirectorySources'
import { historicalComposerSources } from './historicalComposerSources'
import { inspectLocalResource } from './localResource'
import { validateResourceBytes } from './validateResourceBytes'

export interface ComposerResourceServiceOptions {
  artifacts?: Pick<ArtifactService, 'listConversationArtifacts' | 'resolveConversationArtifactLocation'>
  attachments: Pick<AttachmentService, 'cleanupDrafts' | 'listForConversation' | 'registerFiles' | 'registerUploads' | 'release' | 'releaseDraft' | 'resolvePreview'>
  conversationGrants?: Pick<ConversationDirectoryGrantRepository, 'listActive'>
  conversations?: Pick<ConversationRepository, 'findById' | 'listBranchMessages'>
  drafts?: Pick<ComposerDraftRepository, 'findById'>
  eventLog?: Pick<RunEventReader, 'listForRuns'>
  paths: Pick<BuddyDataPaths, 'conversationWorkspace' | 'draftAttachments' | 'spaceWorkspace'>
  repository: ComposerResourceRepository
  spaces?: Pick<SpaceRepository, 'findById'>
}

export interface ComposerSourceScope {
  branchId: string | null
  conversationId: string | null
  spaceId: string | null
}

export class ComposerResourceService {
  readonly #attachments: ComposerResourceServiceOptions['attachments']
  readonly #artifacts: ComposerResourceServiceOptions['artifacts']
  readonly #conversationGrants: ComposerResourceServiceOptions['conversationGrants']
  readonly #conversations: ComposerResourceServiceOptions['conversations']
  readonly #drafts: ComposerResourceServiceOptions['drafts']
  readonly #eventLog: ComposerResourceServiceOptions['eventLog']
  readonly #paths: ComposerResourceServiceOptions['paths']
  readonly #repository: ComposerResourceRepository
  readonly #importing = new Set<string>()
  readonly #spaces: ComposerResourceServiceOptions['spaces']
  readonly #directories: ComposerDirectorySources
  readonly #sensitivePaths = createSensitivePathMatcher()

  constructor(options: ComposerResourceServiceOptions) {
    this.#attachments = options.attachments
    this.#artifacts = options.artifacts
    this.#conversationGrants = options.conversationGrants
    this.#conversations = options.conversations
    this.#drafts = options.drafts
    this.#eventLog = options.eventLog
    this.#paths = options.paths
    this.#repository = options.repository
    this.#spaces = options.spaces
    this.#directories = new ComposerDirectorySources(options)
  }

  async accept(input: BuddyComposerResourceAccept): Promise<BuddyComposerResource[]> {
    const parsed = buddyComposerResourceAcceptSchema.parse(input)
    const incoming = await Promise.all(parsed.resources.map(async (resource) => {
      if (resource.storage === 'reference') {
        const localReference = await inspectLocalResource(resource.sourcePath!)
        return { resource, localReference }
      }
      return { resource: { ...resource, ...normalizeAttachmentMetadata(resource) }, localReference: null }
    }))
    try {
      return this.#repository.acceptBatch(input.draftId, incoming.map(({ resource, localReference }) => localReference
        ? { metadata: { ...localReference, sourcePath: localReference.path, resourceId: resource.resourceId }, source: { localReference } }
        : { metadata: resource }), new Date().toISOString()).map(toPublicResource)
    }
    catch (error) {
      if (error instanceof ComposerResourceConflictError)
        throw new AttachmentError('VALIDATION_FAILED', { cause: error })
      throw error
    }
  }

  list(draftId: string): BuddyComposerResource[] {
    return this.#repository.listForDraft(draftId).map(toPublicResource)
  }

  async resolvePreview(target: BuddyComposerResourceTarget): Promise<{ mimeType: string, path: string }> {
    const resource = this.#requireOwned(target)
    const draft = this.#drafts?.findById(target.draftId)
    if (!draft || resource.state !== 'ready' || !resource.source || !('localReference' in resource.source))
      throw new AttachmentError('ATTACHMENT_NOT_FOUND')
    const conversationId = 'conversationId' in draft.scope ? draft.scope.conversationId : null
    const scope = this.#resolveScope({
      draftId: target.draftId,
      branchId: 'branchId' in draft.scope ? draft.scope.branchId : null,
      conversationId,
      query: '',
      spaceId: 'spaceId' in draft.scope ? draft.scope.spaceId : conversationId ? this.#conversations?.findById(conversationId)?.spaceId ?? null : null,
    })
    const { input } = await this.#resolveLocalInput(resource, resource.source, scope, undefined, 0)
    if (input.attachmentId)
      return this.#attachments.resolvePreview(input.attachmentId)
    const reference = input.localReference!
    if (reference.kind !== 'file' || !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'].includes(reference.mimeType) || reference.sizeBytes > 10 * 1024 * 1024)
      throw new AttachmentError('ATTACHMENT_UNSUPPORTED')
    return { mimeType: reference.mimeType, path: reference.path }
  }

  async selectSpaceFile(
    input: BuddyComposerSpaceFileSelect,
    referencedResourceIds: readonly string[] = [],
  ): Promise<BuddyComposerResource> {
    const parsed = buddyComposerSpaceFileSelectSchema.parse(input)
    return this.selectSource(parsed, referencedResourceIds)
  }

  async listSources(input: BuddyComposerSourceList): Promise<BuddyComposerSourceListResponse> {
    const parsed = buddyComposerSourceListSchema.parse(input)
    const scope = this.#resolveScope(parsed)
    const [directorySources, conversationFiles] = await Promise.all([
      this.#directories.list(scope, parsed.draftId, parsed.query, parsed.deepSearch ?? false),
      this.#listConversationSources(scope, parsed.query),
    ])
    return { ...directorySources, files: [...directorySources.files.slice(0, 64), ...conversationFiles.filter(file => file.category === 'history').slice(0, 32), ...conversationFiles.filter(file => file.category === 'artifact').slice(0, 32)] }
  }

  async selectSource(
    input: BuddyComposerSourceSelect,
    referencedResourceIds: readonly string[] = [],
  ): Promise<BuddyComposerResource> {
    const parsed = buddyComposerSourceSelectSchema.parse(input)
    const resolved = await this.#resolveSource(parsed.source)
    this.#assertCapacity(parsed.draftId, referencedResourceIds, [{ sizeBytes: 'localReference' in resolved.source ? 0 : resolved.metadata.sizeBytes }])
    return toPublicResource(this.#repository.selectSource(parsed.draftId, {
      ...resolved.metadata,
      resourceId: parsed.resourceId,
    }, resolved.source, new Date().toISOString()))
  }

  async selectSpaceFilePath(draftId: string, spaceId: string, path: string): Promise<BuddyComposerResource> {
    const space = requireActiveSpace(this.#spaces?.findById(spaceId) ?? null)
    const bindings = [space.primaryDirectory, ...space.additionalDirectories].filter(binding => binding !== null)
    const requestedPath = isAbsolute(path) ? path : space.primaryDirectory ? join(space.primaryDirectory.canonicalRoot, path) : null
    if (!requestedPath)
      throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
    const resolution = await resolveGrantedPath(bindings.map(binding => ({ canonicalRoot: binding.canonicalRoot, grantId: binding.id, kind: 'workspace', root: binding.root })), requestedPath, 'existing')
    const binding = bindings.find(binding => binding.id === resolution.grantId)!
    return this.selectSpaceFile({ draftId, resourceId: randomUUID(), source: { spaceId, bindingId: binding.id, relativePath: relative(binding.canonicalRoot, resolution.canonicalPath) } })
  }

  async resolveInput(draftId: string, content: BuddyUserContentV1, scope: ComposerSourceScope = { branchId: null, conversationId: null, spaceId: null }, model?: Pick<ResolvedInteractiveModelSelection, 'input' | 'fileInputMimeTypes' | 'api'>): Promise<BuddyUserMessageResourceSnapshot[]> {
    const resourceIds = getBuddyUserContentResourceIds(content)
    if (resourceIds.length > BUDDY_ATTACHMENT_COUNT_LIMIT)
      throw new AttachmentError('VALIDATION_FAILED')
    const resources = resourceIds.map((resourceId) => {
      const resource = this.#requireOwned({ draftId, resourceId })
      if (resource.state !== 'ready')
        throw new AttachmentError('VALIDATION_FAILED')
      if (resource.source && 'spaceId' in resource.source && resource.source.spaceId !== scope.spaceId)
        throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
      if (resource.source && 'conversationId' in resource.source && resource.source.conversationId !== scope.conversationId)
        throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
      return resource
    })
    const result: BuddyUserMessageResourceSnapshot[] = []
    const orderedResources = resources.toSorted((left, right) => Number(isNewLocalReference(left)) - Number(isNewLocalReference(right)))
    let totalBytes = 0
    let remainingNativeBytes = Math.min(base64BytesLength(BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT), (model ? getModelRequestBytesLimit(model.api) : null) ?? Number.POSITIVE_INFINITY) - 1024 * 1024
    for (const resource of orderedResources) {
      if (resource.source && 'localReference' in resource.source) {
        const snapshot = await this.#resolveLocalInput(resource, resource.source, scope, model, Math.min(remainingNativeBytes, base64BytesLength(BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT - totalBytes)))
        result.push(snapshot.input)
        totalBytes += snapshot.bytes
        remainingNativeBytes -= base64BytesLength(snapshot.bytes) + 512
        continue
      }
      if (!resource.source) {
        totalBytes += resource.sizeBytes
        remainingNativeBytes -= base64BytesLength(resource.sizeBytes) + 512
        result.push({ attachmentId: resource.attachmentId!, resourceId: resource.resourceId })
        continue
      }
      const resolved = await this.#resolveSourceOrigin(resource.source, scope)
      totalBytes += resolved.metadata.sizeBytes
      remainingNativeBytes -= base64BytesLength(resolved.metadata.sizeBytes) + 512
      if (totalBytes > BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT)
        throw new AttachmentError('VALIDATION_FAILED')
      if (resolved.attachmentId) {
        result.push({ attachmentId: resolved.attachmentId, resourceId: resource.resourceId })
      }
      else {
        await validateResourceBytes(resolved.metadata, resolved.bytes)
        const [attachment] = await this.#attachments.registerUploads(draftId, [{ ...resolved.metadata, bytes: Uint8Array.from(resolved.bytes) }])
        if (!attachment)
          throw new AttachmentError('ATTACHMENT_NOT_FOUND')
        result.push({ attachmentId: attachment.id, resourceId: resource.resourceId })
      }
    }
    if (totalBytes > BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT)
      throw new AttachmentError('VALIDATION_FAILED')
    const snapshots = new Map(result.map(snapshot => [snapshot.resourceId, snapshot]))
    return resourceIds.map(resourceId => snapshots.get(resourceId)!)
  }

  #resolveScope(input: BuddyComposerSourceList): ComposerSourceScope {
    if ((input.conversationId === null) !== (input.branchId === null))
      throw new BuddyServiceError('VALIDATION_FAILED')
    if (!input.conversationId)
      return { branchId: null, conversationId: null, spaceId: input.spaceId }
    const conversation = this.#conversations?.findById(input.conversationId)
    if (!conversation || conversation.deletedAt !== null || conversation.activeBranchId !== input.branchId)
      throw new BuddyServiceError('VALIDATION_FAILED')
    if (conversation.spaceId !== input.spaceId)
      throw new BuddyServiceError('VALIDATION_FAILED')
    this.#conversations!.listBranchMessages(conversation.id, input.branchId!)
    return { branchId: input.branchId, conversationId: conversation.id, spaceId: conversation.spaceId }
  }

  async #listConversationSources(scope: ComposerSourceScope, query: string): Promise<BuddyComposerSourceOption[]> {
    if (!scope.conversationId || !scope.branchId)
      return []
    const history = this.#requireVisibleHistory(scope.conversationId, scope.branchId)
    const historical = historicalComposerSources(history, this.#attachments.listForConversation(scope.conversationId), scope.conversationId, scope.branchId)
    const visibleArtifactIds = this.#visibleArtifactIds(history)
    const artifacts = (await Promise.all((this.#artifacts?.listConversationArtifacts(scope.conversationId) ?? []).map(async (artifact): Promise<BuddyComposerSourceOption | null> => {
      if (!visibleArtifactIds.has(artifact.id))
        return null
      const source = {
        artifactId: artifact.id,
        branchId: scope.branchId!,
        conversationId: scope.conversationId!,
      }
      try {
        const location = await this.#validateArtifactGrant(source)
        const metadata = await inspectLocalResource(location.path)
        return {
          category: 'artifact',
          description: artifact.relativePath,
          label: metadata.name,
          ...metadata,
          kind: metadata.kind,
          path: location.path,
          source,
        }
      }
      catch {
        return null
      }
    }))).filter((value): value is BuddyComposerSourceOption => value !== null)
    const normalizedQuery = query.toLowerCase()
    return [...historical, ...artifacts].filter(option => [option.label, option.name, option.path, option.history?.createdAt]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(normalizedQuery))
  }

  async #resolveSource(source: BuddyComposerSource): Promise<{
    metadata: ReturnType<typeof normalizeAttachmentMetadata> & { nameSource?: 'file' | 'clipboard', sourcePath?: string }
    source: BuddyComposerSourceOrigin
  }> {
    if ('localPath' in source) {
      const localReference = await inspectLocalResource(source.localPath)
      return { metadata: { ...localReference, sourcePath: localReference.path }, source: { localReference } }
    }
    if ('resourceId' in source) {
      const snapshot = this.#resolveMessageResource(source)
      if (snapshot.localReference)
        return { metadata: { ...snapshot.localReference, sourcePath: snapshot.localReference.path }, source: { localReference: snapshot.localReference, origin: source } }
      return this.#resolveSource({ branchId: source.branchId, conversationId: source.conversationId, messageId: source.messageId, attachmentId: snapshot.attachmentId! })
    }
    if ('artifactId' in source) {
      this.#requireVisibleArtifact(source)
      const { artifact, path } = await this.#validateArtifactGrant(source)
      if (!artifact)
        throw new AttachmentError('ATTACHMENT_NOT_FOUND')
      const localReference = await inspectLocalResource(path)
      return { metadata: { ...localReference, sourcePath: path }, source: { localReference, origin: source } }
    }
    if ('messageId' in source) {
      const attachment = this.#resolveMessageInput(source)
      return { metadata: { ...normalizeAttachmentMetadata(attachment), nameSource: attachment.nameSource, sourcePath: attachment.sourcePath }, source }
    }
    const resolved = await this.#resolveSpaceFile(source)
    return { metadata: resolved.metadata, source: { localReference: resolved.localReference, origin: resolved.source } }
  }

  async #resolveSourceOrigin(source: BuddyComposerSourceOrigin, scope: ComposerSourceScope): Promise<{
    attachmentId: string | null
    bytes: Uint8Array
    metadata: ReturnType<typeof normalizeAttachmentMetadata> & { nameSource?: 'file' | 'clipboard', sourcePath?: string }
  }> {
    if ('localReference' in source)
      throw new AttachmentError('VALIDATION_FAILED')
    if ('artifactId' in source) {
      if (scope.branchId !== source.branchId)
        throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
      this.#requireVisibleArtifact(source)
      const resolved = await this.#validateArtifactGrant(source)
      const bytes = await readBoundedFile(
        resolved.root,
        resolved.path,
        BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT + 1,
      )
      const metadata = normalizeAttachmentMetadata({
        ...resolved.artifact,
        sizeBytes: bytes.byteLength,
      })
      return { attachmentId: null, bytes: Uint8Array.from(bytes), metadata: { ...metadata, sourcePath: resolved.path } }
    }
    if ('messageId' in source) {
      if (scope.branchId !== source.branchId)
        throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
      const attachment = this.#resolveMessageInput(source)
      return { attachmentId: attachment.id, bytes: new Uint8Array(), metadata: { ...normalizeAttachmentMetadata(attachment), nameSource: attachment.nameSource, sourcePath: attachment.sourcePath } }
    }
    const resolved = await this.#resolveSpaceFile(source)
    if (resolved.source.bindingRevision !== source.bindingRevision)
      throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
    const metadata = { ...resolved.metadata, ...normalizeAttachmentMetadata(resolved.metadata) }
    const bytes = await readBoundedFile(resolved.root, resolved.path, metadata.sizeBytes + 1)
    return { attachmentId: null, bytes: Uint8Array.from(bytes), metadata }
  }

  #resolveMessageResource(source: BuddyMessageResourceSource): BuddyUserMessageResourceSnapshot {
    const message = this.#requireVisibleHistory(source.conversationId, source.branchId).find(item => item.id === source.messageId)
    const snapshot = message?.role === 'user' ? readBuddyUserMessageContent(message.content)?.resourceSnapshots.find(item => item.resourceId === source.resourceId) : null
    if (!snapshot)
      throw new AttachmentError('ATTACHMENT_NOT_FOUND')
    return snapshot
  }

  async #resolveLocalInput(resource: ComposerResourceRecord, source: BuddyLocalResourceOrigin, scope: ComposerSourceScope, model: Pick<ResolvedInteractiveModelSelection, 'input' | 'fileInputMimeTypes' | 'api'> | undefined, remainingBytes: number): Promise<{ bytes: number, input: BuddyUserMessageResourceSnapshot }> {
    const origin = source.origin
    if (origin && 'conversationId' in origin && (origin.conversationId !== scope.conversationId || origin.branchId !== scope.branchId))
      throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
    if (origin && 'resourceId' in origin) {
      const snapshot = this.#resolveMessageResource(origin)
      const attachment = snapshot.attachmentId ? this.#resolveMessageInput({ ...origin, attachmentId: snapshot.attachmentId }) : null
      return { bytes: attachment?.sizeBytes ?? 0, input: { ...snapshot, resourceId: resource.resourceId } }
    }
    if (origin && 'spaceId' in origin) {
      if (origin.spaceId !== scope.spaceId)
        throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
      const current = await this.#resolveSpaceFile(origin)
      if (current.source.bindingRevision !== origin.bindingRevision || current.path !== source.localReference.path)
        throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
    }
    if (origin && 'artifactId' in origin) {
      this.#requireVisibleArtifact(origin)
      if ((await this.#validateArtifactGrant(origin)).path !== source.localReference.path)
        throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
    }
    const localReference = await inspectLocalResource(source.localReference.path)
    if (localReference.path !== source.localReference.path || localReference.kind !== source.localReference.kind)
      throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
    const input: BuddyUserMessageResourceSnapshot = { localReference, resourceId: resource.resourceId }
    const nativeSupported = model && (localReference.mimeType.startsWith('image/')
      ? model.input.includes('image')
      : (model.fileInputMimeTypes as readonly string[]).includes(localReference.mimeType))
    if (localReference.kind !== 'file' || !nativeSupported || base64BytesLength(localReference.sizeBytes) + 512 > remainingBytes)
      return { bytes: 0, input }
    try {
      normalizeAttachmentMetadata(localReference)
    }
    catch (error) {
      if (error instanceof AttachmentError && ['ATTACHMENT_TOO_LARGE', 'ATTACHMENT_UNSUPPORTED', 'ATTACHMENT_INVALID'].includes(error.code))
        return { bytes: 0, input }
      throw error
    }
    const bytes = await readBoundedFile(dirname(localReference.path), localReference.path, localReference.sizeBytes + 1)
    try {
      await validateResourceBytes(localReference, bytes)
    }
    catch (error) {
      if (error instanceof AttachmentError && error.code === 'ATTACHMENT_INVALID')
        return { bytes: 0, input }
      throw error
    }
    const [attachment] = await this.#attachments.registerUploads(resource.draftId, [{ ...localReference, sourcePath: localReference.path, bytes: Uint8Array.from(bytes) }])
    if (!attachment)
      throw new AttachmentError('ATTACHMENT_NOT_FOUND')
    return { bytes: localReference.sizeBytes, input: { ...input, attachmentId: attachment.id } }
  }

  #resolveMessageInput(source: BuddyMessageInputSource): AttachmentRecord {
    const message = this.#requireVisibleHistory(source.conversationId, source.branchId)
      .find(item => item.id === source.messageId)
    const attachment = this.#attachments.listForConversation(source.conversationId)
      .find(item => item.id === source.attachmentId)
    if (!message || message.role !== 'user' || !attachment || attachment.messageId !== message.id)
      throw new AttachmentError('ATTACHMENT_NOT_FOUND')
    return attachment
  }

  #requireVisibleHistory(conversationId: string, branchId: string) {
    const conversation = this.#conversations?.findById(conversationId)
    if (!conversation || conversation.deletedAt !== null || conversation.activeBranchId !== branchId)
      throw new BuddyServiceError('VALIDATION_FAILED')
    return this.#conversations!.listBranchMessages(conversationId, branchId)
  }

  #visibleArtifactIds(history: ReturnType<NonNullable<ComposerResourceServiceOptions['conversations']>['listBranchMessages']>): Set<string> {
    const runIds = history.flatMap(message => message.runId ? [message.runId] : [])
    return new Set((this.#eventLog?.listForRuns(runIds) ?? []).flatMap((event) => {
      if (event.type !== 'output.produced')
        return []
      const output = buddyRunOutputPayloadSchema.safeParse(event.payload)
      return output.success ? output.data.artifactIds : []
    }))
  }

  #requireVisibleArtifact(source: BuddyArtifactSource): void {
    const history = this.#requireVisibleHistory(source.conversationId, source.branchId)
    if (!this.#visibleArtifactIds(history).has(source.artifactId))
      throw new AttachmentError('ATTACHMENT_NOT_FOUND')
  }

  async #validateArtifactGrant(source: BuddyArtifactSource): Promise<{
    artifact: ArtifactResource
    path: string
    root: string
  }> {
    const location = this.#artifacts?.resolveConversationArtifactLocation(
      source.conversationId,
      source.artifactId,
    )
    const artifact = location?.resource
    const conversation = this.#conversations?.findById(source.conversationId)
    if (!artifact || !conversation)
      throw new AttachmentError('ATTACHMENT_NOT_FOUND')
    const grants = conversation.spaceId
      ? (() => {
          const space = requireActiveSpace(this.#spaces?.findById(conversation.spaceId) ?? null)
          return [space.primaryDirectory, ...space.additionalDirectories]
        })()
          .filter(grant => grant !== null)
      : this.#conversationGrants?.listActive(conversation.id) ?? []
    const ownerId = conversation.spaceId ?? conversation.id
    const grant = grants.find(item => item.id === artifact.directoryGrantId) ?? (
      artifact.directoryGrantId === ownerId
        ? {
            canonicalRoot: await realpath(conversation.spaceId ? this.#paths.spaceWorkspace(ownerId) : this.#paths.conversationWorkspace(ownerId)),
            id: ownerId,
            root: conversation.spaceId ? this.#paths.spaceWorkspace(ownerId) : this.#paths.conversationWorkspace(ownerId),
          }
        : null
    )
    if (!grant)
      throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
    if (grant.canonicalRoot !== location.canonicalRoot)
      throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
    const resolution = await resolveGrantedPath(
      [{ canonicalRoot: grant.canonicalRoot, grantId: grant.id, kind: 'workspace', root: grant.root }],
      join(grant.canonicalRoot, artifact.relativePath),
      'existing',
    )
    if (resolution.canonicalPath !== location.canonicalPath)
      throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
    return {
      artifact,
      path: resolution.canonicalPath,
      root: grant.canonicalRoot,
    }
  }

  async #resolveSpaceFile(source: BuddySpaceFileSource): Promise<{
    metadata: ReturnType<typeof normalizeAttachmentMetadata> & { nameSource?: 'file' | 'clipboard', sourcePath?: string }
    path: string
    root: string
    source: BuddySpaceFileOrigin
    localReference: Awaited<ReturnType<typeof inspectLocalResource>>
  }> {
    const space = requireActiveSpace(this.#spaces?.findById(source.spaceId) ?? null)
    const binding = [space.primaryDirectory, ...space.additionalDirectories].find(directory => directory?.id === source.bindingId)
    if (!binding || binding.revokedAt || isAbsolute(source.relativePath))
      throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
    const resolution = await resolveGrantedPath([{
      canonicalRoot: binding.canonicalRoot,
      grantId: binding.id,
      kind: 'workspace',
      root: binding.root,
    }], join(binding.canonicalRoot, source.relativePath), 'existing')
    if (this.#sensitivePaths.matches(resolution.canonicalPath))
      throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
    const localReference = await inspectLocalResource(resolution.canonicalPath)
    return {
      metadata: { ...localReference, sourcePath: resolution.canonicalPath },
      localReference,
      path: resolution.canonicalPath,
      root: binding.canonicalRoot,
      source: { bindingId: binding.id, bindingRevision: binding.revision, relativePath: relative(binding.canonicalRoot, resolution.canonicalPath) || '.', spaceId: space.id },
    }
  }

  async complete(input: BuddyComposerResourceComplete): Promise<BuddyComposerResource> {
    const resource = this.#requireOwned(input)
    if (resource.source)
      throw new AttachmentError('VALIDATION_FAILED')
    const contentHash = createHash('sha256').update(input.bytes).digest('hex')
    if (resource.state === 'ready') {
      if (resource.contentHash !== contentHash)
        throw new AttachmentError('VALIDATION_FAILED')
      return toPublicResource(resource)
    }
    if (resource.state !== 'importing' || this.#importing.has(input.resourceId))
      throw new AttachmentError('VALIDATION_FAILED')

    this.#importing.add(input.resourceId)
    try {
      await validateResourceBytes(resource, input.bytes)
      const [attachment] = await this.#attachments.registerUploads(input.draftId, [{
        bytes: input.bytes,
        mimeType: resource.mimeType,
        name: resource.name,
        nameSource: resource.nameSource,
        sourcePath: resource.sourcePath,
      }])
      if (!attachment)
        throw new AttachmentError('ATTACHMENT_NOT_FOUND')
      if (!this.#repository.finish({
        attachmentId: attachment.id,
        contentHash,
        draftId: input.draftId,
        now: new Date().toISOString(),
        resourceId: input.resourceId,
      })) {
        await this.#attachments.release([attachment.id])
        throw new AttachmentError('VALIDATION_FAILED')
      }
      return toPublicResource(this.#requireOwned(input))
    }
    catch (error) {
      const failed = this.fail(input)
      if (error instanceof AttachmentError && ['ATTACHMENT_INVALID', 'ATTACHMENT_UNSUPPORTED', 'ATTACHMENT_TOO_LARGE'].includes(error.code))
        throw error
      return failed
    }
    finally {
      this.#importing.delete(input.resourceId)
    }
  }

  fail(input: BuddyComposerResourceTarget): BuddyComposerResource {
    this.#requireOwned(input)
    this.#repository.fail(input.draftId, input.resourceId, 'IMPORT_FAILED', new Date().toISOString())
    return toPublicResource(this.#requireOwned(input))
  }

  retry(input: BuddyComposerResourceTarget): BuddyComposerResource {
    this.#requireOwned(input)
    if (this.#importing.has(input.resourceId))
      throw new AttachmentError('VALIDATION_FAILED')
    this.#repository.retry(input.draftId, input.resourceId, new Date().toISOString())
    return toPublicResource(this.#requireOwned(input))
  }

  async registerFiles(input: {
    draftId: string
    paths: readonly string[]
    referencedResourceIds?: readonly string[]
  }): Promise<BuddyComposerResource[]> {
    const { draftId, paths, referencedResourceIds = [] } = input
    if (!paths.length)
      return []
    const capacity = this.#remainingCapacity(draftId, referencedResourceIds)
    if (paths.length > capacity.count)
      throw new AttachmentError('ATTACHMENT_LIMIT_EXCEEDED')
    const locals = await Promise.all(paths.map(path => inspectLocalResource(path)))
    return this.accept({
      draftId,
      resources: locals.map(resource => ({
        mimeType: resource.mimeType,
        name: resource.name,
        sourcePath: resource.path,
        storage: 'reference',
        resourceId: randomUUID(),
        sizeBytes: resource.sizeBytes,
      })),
    })
  }

  recoverInterruptedImports(unavailableAttachmentIds: readonly string[] = []): void {
    this.#repository.interruptImports(new Date().toISOString())
    this.#repository.failUnavailableAttachments(unavailableAttachmentIds, new Date().toISOString())
  }

  async cleanupDrafts(now = Date.now()): Promise<string[]> {
    const cutoff = new Date(now - DRAFT_ATTACHMENT_RETENTION_MS).toISOString()
    const staleResources = this.#repository.listAll().filter(resource => resource.createdAt < cutoff)
    const retainedAttachmentIds = new Set<string>()
    const removableByDraft = new Map<string, string[]>()

    for (const resource of staleResources) {
      const draft = this.#drafts?.findById(resource.draftId)
      const referenced = draft
        ? getBuddyUserContentResourceIds(draft.content).includes(resource.resourceId)
        : false
      if (referenced) {
        if (resource.attachmentId)
          retainedAttachmentIds.add(resource.attachmentId)
        continue
      }
      const ids = removableByDraft.get(resource.draftId) ?? []
      ids.push(resource.resourceId)
      removableByDraft.set(resource.draftId, ids)
    }

    for (const [draftId, resourceIds] of removableByDraft)
      this.#repository.remove(draftId, resourceIds)
    return this.#attachments.cleanupDrafts(now, retainedAttachmentIds)
  }

  async discard(draftId: string): Promise<void> {
    this.#repository.remove(draftId, this.#repository.listForDraft(draftId).map(resource => resource.resourceId))
    await this.#attachments.releaseDraft(draftId)
  }

  #requireOwned(input: BuddyComposerResourceTarget): ComposerResourceRecord {
    const resource = this.#repository.findById(input.resourceId)
    if (!resource || resource.draftId !== input.draftId)
      throw new AttachmentError('ATTACHMENT_NOT_FOUND')
    return resource
  }

  #assertCapacity(
    draftId: string,
    referencedResourceIds: readonly string[],
    incoming: readonly Pick<BuddyComposerResource, 'sizeBytes'>[],
  ): void {
    const capacity = this.#remainingCapacity(draftId, referencedResourceIds)
    const incomingBytes = incoming.reduce((total, resource) => total + resource.sizeBytes, 0)
    if (incoming.length > capacity.count || incomingBytes > capacity.totalBytes)
      throw new AttachmentError('ATTACHMENT_LIMIT_EXCEEDED')
  }

  #remainingCapacity(draftId: string, referencedResourceIds: readonly string[]) {
    if (
      referencedResourceIds.length > BUDDY_ATTACHMENT_COUNT_LIMIT
      || new Set(referencedResourceIds).size !== referencedResourceIds.length
    ) {
      throw new AttachmentError('VALIDATION_FAILED')
    }
    const usedBytes = referencedResourceIds.reduce(
      (total, resourceId) => {
        const resource = this.#requireOwned({ draftId, resourceId })
        return total + (resource.source && 'localReference' in resource.source ? 0 : resource.sizeBytes)
      },
      0,
    )
    if (usedBytes > BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT)
      throw new AttachmentError('VALIDATION_FAILED')
    return {
      count: BUDDY_ATTACHMENT_COUNT_LIMIT - referencedResourceIds.length,
      totalBytes: BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT - usedBytes,
    }
  }
}

function isNewLocalReference(resource: ComposerResourceRecord): boolean {
  return Boolean(resource.source && 'localReference' in resource.source && !(resource.source.origin && 'resourceId' in resource.source.origin))
}

function toPublicResource(resource: ComposerResourceRecord): BuddyComposerResource {
  const localReference = resource.source && 'localReference' in resource.source ? resource.source.localReference : undefined
  const base = {
    draftId: resource.draftId,
    kind: localReference?.kind === 'directory' ? 'directory' as const : resource.mimeType === 'application/octet-stream' ? 'binary' as const : getAttachmentKind(resource.mimeType),
    localReference,
    mimeType: resource.mimeType,
    name: resource.name,
    nameSource: resource.nameSource,
    sourcePath: resource.sourcePath,
    resourceId: resource.resourceId,
    sizeBytes: resource.sizeBytes,
  }
  switch (resource.state) {
    case 'ready': return resource.source
      ? {
          ...base,
          previewUrl: null,
          source: resource.source,
          state: 'ready',
        }
      : {
          ...base,
          attachmentId: resource.attachmentId!,
          previewUrl: base.kind === 'image' ? `lexora-attachment://preview/${resource.attachmentId}` : null,
          state: 'ready',
        }
    case 'failed': return { ...base, errorCode: resource.errorCode!, state: 'failed' }
    case 'importing': return { ...base, state: 'importing' }
  }
}

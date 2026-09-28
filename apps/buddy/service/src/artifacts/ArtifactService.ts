import type { ImageContent } from '@earendil-works/pi-ai'
import type { Buffer } from 'node:buffer'
import type { DirectoryGrant } from '../directories/resolveGrantedPath'
import type {
  ArtifactRecord,
  ArtifactRepository,
} from '../storage/artifactRepository'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  resolve,
  sep,
} from 'node:path'
import { relativeCanonicalPath } from '../../../platform/filesystem/filePaths'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { resolveGrantedPath } from '../directories/resolveGrantedPath'

export const BUDDY_ARTIFACT_COUNT_LIMIT = 512
export const BUDDY_ARTIFACT_TOTAL_BYTES_LIMIT = 32 * 1024 * 1024
export const BUDDY_ARTIFACT_TEXT_BYTES_LIMIT = 2 * 1024 * 1024

export interface GeneratedArtifactImage {
  bytes: Uint8Array
  mimeType: string
}

export type ArtifactResource = Omit<ArtifactRecord, 'currentPath' | 'directoryRoot'>

export interface ConversationArtifactLocation {
  canonicalPath: string
  canonicalRoot: string
  resource: ArtifactResource
}

export interface ArtifactBatchReceipt {
  readonly operationId: string
  readonly conversationId: string
  readonly cause: 'presentation' | 'generated' | 'recovery'
  readonly requested: number
  readonly written: number
  readonly unconfirmedWrites: number
  readonly artifactIds: readonly string[]
  readonly stage: 'validation' | 'file' | 'catalogue'
  readonly outcome: 'pending' | 'completed' | 'partial' | 'failed'
}

export interface ArtifactEvent {
  readonly sourceId: string
  readonly revision: number
  readonly kind: 'file-written' | 'catalogue-committed' | 'batch-settled'
  readonly receipt: ArtifactBatchReceipt
  readonly artifactId?: string
  readonly created?: boolean
  readonly errorCode?: 'ARTIFACT_PUBLICATION_FAILED'
}

interface ArtifactBatch {
  operationId: string
  conversationId: string
  cause: ArtifactBatchReceipt['cause']
  requested: number
  written: number
  unconfirmedWrites: number
  artifactIds: string[]
  stage: ArtifactBatchReceipt['stage']
}

interface PresentOutputsInput {
  conversationId: string
  cwd: string
  grants: readonly DirectoryGrant[]
  paths: readonly string[]
  sourceArtifactId?: string | null
}

interface GeneratedImagesInput {
  conversationId: string
  cwd: string
  grants: readonly DirectoryGrant[]
  images: readonly GeneratedArtifactImage[]
  outputPath: string
  sourceArtifactId: string | null
}

export class ArtifactService {
  readonly #repository: ArtifactRepository
  readonly #sourceId = randomUUID()
  readonly #changes: Emitter<ArtifactEvent>
  readonly onDidChange
  readonly #pending = new Set<Promise<unknown>>()
  #revision = 0
  #disposed = false

  constructor(options: { repository: ArtifactRepository, onListenerError?: (error: unknown) => void }) {
    this.#repository = options.repository
    this.#changes = new Emitter(options.onListenerError ?? (() => console.error('ARTIFACT_OBSERVER_FAILED')))
    this.onDidChange = this.#changes.event
  }

  presentOutputs(input: PresentOutputsInput): Promise<ArtifactRecord[]> {
    const request = copyEventSnapshot({ conversationId: input.conversationId, cwd: input.cwd, grants: input.grants, paths: input.paths, sourceArtifactId: input.sourceArtifactId })
    return this.#batch(request.conversationId, 'presentation', request.paths.length, batch => this.#presentOutputs(request, batch))
  }

  registerGeneratedImages(input: GeneratedImagesInput): Promise<ArtifactRecord[]> {
    const request = { ...copyEventSnapshot({ conversationId: input.conversationId, cwd: input.cwd, grants: input.grants, outputPath: input.outputPath, sourceArtifactId: input.sourceArtifactId }), images: input.images.map(image => ({ bytes: Uint8Array.from(image.bytes), mimeType: image.mimeType })) }
    return this.#batch(request.conversationId, 'generated', request.images.length, batch => this.#registerGeneratedImages(request, batch))
  }

  recoverLegacyRecords(records: readonly ArtifactRecord[]): Promise<number> {
    const request = copyEventSnapshot(records)
    if (!request.length)
      return Promise.resolve(0)
    return this.#batch(request[0]!.conversationId, 'recovery', request.length, async (batch) => {
      for (const record of request) {
        if (record.conversationId !== batch.conversationId)
          throw new ArtifactError('VALIDATION_FAILED')
        const existing = this.#repository.findById(record.id)
        const path = this.#repository.findByCurrentPath(record.conversationId, record.currentPath)
        if (existing || path) {
          if (existing?.conversationId !== record.conversationId || existing.currentPath !== record.currentPath || path?.id !== record.id)
            throw new ArtifactError('VALIDATION_FAILED')
          continue
        }
        batch.stage = 'catalogue'
        this.#repository.save(record)
        batch.artifactIds.push(record.id)
        this.#publish(batch, 'catalogue-committed', { artifactId: record.id, created: true })
      }
      return batch.artifactIds.length
    })
  }

  async whenIdle(): Promise<void> {
    while (this.#pending.size)
      await Promise.allSettled([...this.#pending])
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    await this.whenIdle()
    this.#changes.dispose()
  }

  #batch<T>(conversationId: string, cause: ArtifactBatchReceipt['cause'], requested: number, operation: (batch: ArtifactBatch) => Promise<T>): Promise<T> {
    if (this.#disposed)
      return Promise.reject(new ArtifactError('ARTIFACT_SERVICE_STOPPED'))
    const batch: ArtifactBatch = { conversationId, cause, requested, operationId: randomUUID(), written: 0, unconfirmedWrites: 0, artifactIds: [], stage: 'validation' }
    const pending = Promise.resolve().then(() => operation(batch)).then((result) => {
      this.#publish(batch, 'batch-settled', {}, 'completed')
      return result
    }, (error: unknown) => {
      const outcome = batch.written || batch.unconfirmedWrites || batch.artifactIds.length ? 'partial' : 'failed'
      const receipt = this.#publish(batch, 'batch-settled', { errorCode: 'ARTIFACT_PUBLICATION_FAILED' }, outcome)
      throw new ArtifactPublicationError(error, receipt)
    }).finally(() => this.#pending.delete(pending))
    this.#pending.add(pending)
    return pending
  }

  #publish(batch: ArtifactBatch, kind: ArtifactEvent['kind'], details: Pick<ArtifactEvent, 'artifactId' | 'created' | 'errorCode'> = {}, outcome: ArtifactBatchReceipt['outcome'] = 'pending'): ArtifactBatchReceipt {
    const receipt = copyEventSnapshot({ ...batch, outcome })
    this.#changes.fire(copyEventSnapshot({ sourceId: this.#sourceId, revision: ++this.#revision, kind, receipt, ...details }))
    return receipt
  }

  async #presentOutputs(input: PresentOutputsInput, batch: ArtifactBatch): Promise<ArtifactRecord[]> {
    if (
      input.paths.length === 0
      || input.paths.length > BUDDY_ARTIFACT_COUNT_LIMIT
      || input.paths.some(path => !path.trim())
    ) {
      throw new ArtifactError('VALIDATION_FAILED')
    }
    const sourceArtifactId = input.sourceArtifactId ?? null
    if (sourceArtifactId)
      this.#requireConversationArtifact(input.conversationId, sourceArtifactId)

    const candidates = await Promise.all(input.paths.map(async (requestedPath) => {
      const absolutePath = isAbsolute(requestedPath)
        ? requestedPath
        : resolve(input.cwd, requestedPath)
      const location = await resolveArtifactLocation(input.grants, absolutePath)
      if (isSensitivePath(location.relativePath))
        throw new ArtifactError('ARTIFACT_SENSITIVE_PATH')
      const metadata = await stat(location.canonicalPath)
      if (!metadata.isFile() && !metadata.isDirectory())
        throw new ArtifactError('VALIDATION_FAILED')
      return {
        kind: metadata.isDirectory() ? 'directory' as const : 'file' as const,
        location,
        mimeType: metadata.isDirectory()
          ? 'inode/directory'
          : inferArtifactMimeType(location.canonicalPath),
        sizeBytes: metadata.isFile() ? metadata.size : 0,
      }
    }))
    const uniqueCandidates = [...new Map(
      candidates.map(candidate => [candidate.location.canonicalPath, candidate]),
    ).values()]

    return uniqueCandidates.map((candidate) => {
      const existing = this.#repository.findByCurrentPath(
        input.conversationId,
        candidate.location.canonicalPath,
      )
      const normalizedSourceArtifactId = sourceArtifactId === existing?.id
        ? existing.sourceArtifactId
        : sourceArtifactId || existing?.sourceArtifactId || null
      const now = new Date().toISOString()
      batch.stage = 'catalogue'
      const record = this.#repository.save({
        conversationId: input.conversationId,
        createdAt: existing?.createdAt ?? now,
        currentPath: candidate.location.canonicalPath,
        directoryGrantId: candidate.location.grant.grantId,
        directoryRoot: candidate.location.grant.canonicalRoot,
        id: existing?.id ?? randomUUID(),
        kind: candidate.kind,
        mimeType: candidate.mimeType,
        name: basename(candidate.location.canonicalPath),
        relativePath: candidate.location.relativePath,
        sizeBytes: candidate.sizeBytes,
        sourceArtifactId: normalizedSourceArtifactId,
        updatedAt: now,
      })
      batch.artifactIds.push(record.id)
      this.#publish(batch, 'catalogue-committed', { artifactId: record.id, created: !existing })
      return record
    })
  }

  async #registerGeneratedImages(input: GeneratedImagesInput, batch: ArtifactBatch): Promise<ArtifactRecord[]> {
    if (
      input.images.length === 0
      || input.images.length > BUDDY_ARTIFACT_COUNT_LIMIT
      || !input.outputPath.trim()
    ) {
      throw new ArtifactError('VALIDATION_FAILED')
    }
    const totalBytes = input.images.reduce(
      (total, image) => total + image.bytes.byteLength,
      0,
    )
    if (totalBytes > BUDDY_ARTIFACT_TOTAL_BYTES_LIMIT)
      throw new ArtifactError('ARTIFACT_SIZE_LIMIT')
    if (input.images.some(image => (
      image.bytes.byteLength === 0 || !image.mimeType.startsWith('image/')
    ))) {
      throw new ArtifactError('VALIDATION_FAILED')
    }
    if (input.sourceArtifactId)
      this.#requireConversationArtifact(input.conversationId, input.sourceArtifactId)

    const basePath = isAbsolute(input.outputPath)
      ? input.outputPath
      : resolve(input.cwd, input.outputPath)
    const outputPaths = input.images.map((image, index) => (
      generatedImagePath(basePath, index, image.mimeType)
    ))
    if (new Set(outputPaths).size !== outputPaths.length)
      throw new ArtifactError('VALIDATION_FAILED')

    for (const [index, image] of input.images.entries()) {
      const outputPath = outputPaths[index]!
      const location = await resolveArtifactLocation(input.grants, outputPath, 'create')
      if (isSensitivePath(location.relativePath))
        throw new ArtifactError('ARTIFACT_SENSITIVE_PATH')
      batch.stage = 'file'
      await mkdir(dirname(location.canonicalPath), { mode: 0o700, recursive: true })
      batch.unconfirmedWrites += 1
      await writeFile(location.canonicalPath, image.bytes, { mode: 0o600 })
      batch.unconfirmedWrites -= 1
      batch.written += 1
      this.#publish(batch, 'file-written')
    }
    batch.stage = 'catalogue'
    return this.#presentOutputs({
      conversationId: input.conversationId,
      cwd: input.cwd,
      grants: input.grants,
      paths: outputPaths,
      sourceArtifactId: input.sourceArtifactId,
    }, batch)
  }

  listConversationArtifacts(
    conversationId: string,
    limit = BUDDY_ARTIFACT_COUNT_LIMIT,
  ): ArtifactResource[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > BUDDY_ARTIFACT_COUNT_LIMIT)
      throw new ArtifactError('VALIDATION_FAILED')
    return this.#repository.listForConversation(conversationId)
      .slice(-limit)
      .reverse()
      .map(toArtifactResource)
  }

  resolveConversationArtifactLocation(
    conversationId: string,
    artifactId: string,
  ): ConversationArtifactLocation {
    const artifact = this.#requireConversationArtifact(conversationId, artifactId)
    return {
      canonicalPath: artifact.currentPath,
      canonicalRoot: artifact.directoryRoot,
      resource: toArtifactResource(artifact),
    }
  }

  async materializeConversationArtifact(
    conversationId: string,
    artifactId: string,
  ): Promise<{ bytes: Buffer, resource: ArtifactResource }> {
    const artifact = this.#requireConversationArtifact(conversationId, artifactId)
    if (artifact.kind !== 'file')
      throw new ArtifactError('VALIDATION_FAILED')
    const metadata = await stat(artifact.currentPath)
    if (metadata.size > BUDDY_ARTIFACT_TOTAL_BYTES_LIMIT)
      throw new ArtifactError('ARTIFACT_SIZE_LIMIT')
    const bytes = await readFile(artifact.currentPath)
    if (bytes.byteLength > BUDDY_ARTIFACT_TOTAL_BYTES_LIMIT)
      throw new ArtifactError('ARTIFACT_SIZE_LIMIT')
    return {
      bytes,
      resource: toArtifactResource(artifact),
    }
  }

  async resolveBrowserEntry(
    conversationId: string,
    artifactId: string,
  ): Promise<{ entryPath: string, rootPath: string }> {
    const artifact = this.#requireConversationArtifact(conversationId, artifactId)
    const extension = extname(artifact.name).toLowerCase()
    if (
      artifact.kind !== 'file'
      || artifact.mimeType !== 'text/html'
      || (extension !== '.htm' && extension !== '.html')
    ) {
      throw new ArtifactError('VALIDATION_FAILED')
    }
    return {
      entryPath: artifact.currentPath,
      rootPath: artifact.directoryRoot === artifact.currentPath
        ? dirname(artifact.currentPath)
        : artifact.directoryRoot,
    }
  }

  resolvePreview(id: string): { mimeType: string, path: string } {
    const artifact = this.#requireVisibleArtifact(id)
    if (artifact.kind !== 'file' || !artifact.mimeType.startsWith('image/'))
      throw new ArtifactError('VALIDATION_FAILED')
    return { mimeType: artifact.mimeType, path: artifact.currentPath }
  }

  async readText(id: string): Promise<{
    artifactId: string
    language: string | null
    text: string
  }> {
    const artifact = this.#requireVisibleArtifact(id)
    if (
      artifact.kind !== 'file'
      || (!isTextArtifact(artifact.mimeType) && inferArtifactMimeType(artifact.name) !== 'text/markdown')
      || artifact.sizeBytes > BUDDY_ARTIFACT_TEXT_BYTES_LIMIT
    ) {
      throw new ArtifactError('VALIDATION_FAILED')
    }
    const bytes = await readFile(artifact.currentPath)
    if (bytes.byteLength > BUDDY_ARTIFACT_TEXT_BYTES_LIMIT)
      throw new ArtifactError('ARTIFACT_SIZE_LIMIT')
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    }
    catch {
      throw new ArtifactError('VALIDATION_FAILED')
    }
    return {
      artifactId: artifact.id,
      language: languageFromArtifactName(artifact.name),
      text,
    }
  }

  async materializeConversationImages(
    conversationId: string,
    ids?: readonly string[],
  ): Promise<{ images: ImageContent[], records: ArtifactRecord[] }> {
    const available = this.#repository.listForConversation(conversationId)
      .filter(record => record.kind === 'file' && record.mimeType.startsWith('image/'))
    const selected = ids === undefined
      ? available.slice(-1)
      : ids.map(id => this.#requireConversationArtifact(conversationId, id))
          .filter((artifact) => {
            if (artifact.kind !== 'file' || !artifact.mimeType.startsWith('image/'))
              throw new ArtifactError('ARTIFACT_NOT_FOUND')
            return true
          })
    const images = await Promise.all(selected.map(async (artifact): Promise<ImageContent> => ({
      data: (await readFile(artifact.currentPath)).toString('base64'),
      mimeType: artifact.mimeType,
      type: 'image',
    })))
    return { images, records: selected }
  }

  #requireVisibleArtifact(id: string): ArtifactRecord {
    const artifact = this.#repository.findVisibleById(id)
    if (!artifact)
      throw new ArtifactError('ARTIFACT_NOT_FOUND')
    return artifact
  }

  #requireConversationArtifact(conversationId: string, artifactId: string): ArtifactRecord {
    const artifact = this.#requireVisibleArtifact(artifactId)
    if (artifact.conversationId !== conversationId)
      throw new ArtifactError('ARTIFACT_NOT_FOUND')
    return artifact
  }
}

export class ArtifactError extends Error {
  readonly code: string

  constructor(code: string) {
    super('Lexora Buddy artifact operation failed')
    this.name = 'ArtifactError'
    this.code = code
  }
}

export class ArtifactPublicationError extends ArtifactError {
  readonly receipt: ArtifactBatchReceipt

  constructor(error: unknown, receipt: ArtifactBatchReceipt) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
      ? error.code
      : 'ARTIFACT_PUBLICATION_FAILED'
    super(code)
    this.name = 'ArtifactPublicationError'
    this.receipt = copyEventSnapshot(receipt)
  }
}

interface ArtifactLocation {
  canonicalPath: string
  grant: DirectoryGrant
  relativePath: string
}

async function resolveArtifactLocation(
  grants: readonly DirectoryGrant[],
  path: string,
  mode: 'create' | 'existing' = 'existing',
): Promise<ArtifactLocation> {
  if (!isAbsolute(path))
    throw new ArtifactError('VALIDATION_FAILED')
  const resolution = await resolveGrantedPath(grants, path, mode)
  const grant = grants.find(candidate => candidate.grantId === resolution.grantId)
  if (!grant)
    throw new ArtifactError('PATH_OUTSIDE_GRANTED_DIRECTORY')
  const child = relativeCanonicalPath(grant.canonicalRoot, resolution.canonicalPath)
  if (child === null)
    throw new ArtifactError('PATH_OUTSIDE_GRANTED_DIRECTORY')
  return {
    canonicalPath: resolution.canonicalPath,
    grant,
    relativePath: child ? child.split(sep).join('/') : '.',
  }
}

function generatedImagePath(basePath: string, index: number, mimeType: string): string {
  const expectedExtension = extensionForImageMimeType(mimeType)
  const extension = extname(basePath).toLowerCase()
  if (extension && !matchingImageExtension(extension, expectedExtension))
    throw new ArtifactError('VALIDATION_FAILED')
  const pathWithoutExtension = extension ? basePath.slice(0, -extension.length) : basePath
  const suffix = index === 0 ? '' : `-${index + 1}`
  return `${pathWithoutExtension}${suffix}${extension || expectedExtension}`
}

function matchingImageExtension(actual: string, expected: string): boolean {
  return actual === expected
    || (expected === '.jpg' && actual === '.jpeg')
}

function extensionForImageMimeType(mimeType: string): string {
  const extension = new Map([
    ['image/gif', '.gif'],
    ['image/jpeg', '.jpg'],
    ['image/png', '.png'],
    ['image/webp', '.webp'],
  ]).get(mimeType)
  if (!extension)
    throw new ArtifactError('VALIDATION_FAILED')
  return extension
}

function isSensitivePath(path: string): boolean {
  return path.split('/').some((segment) => {
    const name = segment.toLowerCase()
    const extension = extname(name)
    const isEnv = name === '.env' || name.startsWith('.env.')
    const isTemplate = /\.(?:example|sample|template|defaults?|dist|schema)$/i.test(name)
    return (isEnv && !isTemplate)
      || ['.credential', '.key', '.p12', '.pem'].includes(extension)
      || ['id_dsa', 'id_ecdsa', 'id_ed25519', 'id_rsa'].includes(name)
  })
}

export function inferArtifactMimeType(path: string): string {
  return new Map([
    ['.css', 'text/css'],
    ['.csv', 'text/csv'],
    ['.gif', 'image/gif'],
    ['.htm', 'text/html'],
    ['.html', 'text/html'],
    ['.jpeg', 'image/jpeg'],
    ['.jpg', 'image/jpeg'],
    ['.js', 'text/javascript'],
    ['.json', 'application/json'],
    ['.md', 'text/markdown'],
    ['.markdown', 'text/markdown'],
    ['.pdf', 'application/pdf'],
    ['.png', 'image/png'],
    ['.py', 'text/x-python'],
    ['.rs', 'text/x-rust'],
    ['.scss', 'text/x-scss'],
    ['.svg', 'image/svg+xml'],
    ['.toml', 'application/toml'],
    ['.ts', 'text/typescript'],
    ['.tsx', 'text/typescript-jsx'],
    ['.tsv', 'text/tab-separated-values'],
    ['.txt', 'text/plain'],
    ['.vue', 'text/x-vue'],
    ['.webp', 'image/webp'],
    ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['.xml', 'application/xml'],
    ['.yaml', 'application/yaml'],
    ['.yml', 'application/yaml'],
    ['.zip', 'application/zip'],
  ]).get(extname(path).toLowerCase()) ?? 'application/octet-stream'
}

function isTextArtifact(mimeType: string): boolean {
  return mimeType.startsWith('text/') || [
    'application/json',
    'application/toml',
    'application/xml',
    'application/yaml',
  ].includes(mimeType)
}

function languageFromArtifactName(name: string): string | null {
  return new Map([
    ['css', 'css'],
    ['html', 'html'],
    ['js', 'javascript'],
    ['json', 'javascript'],
    ['md', 'markdown'],
    ['markdown', 'markdown'],
    ['py', 'python'],
    ['rs', 'rust'],
    ['scss', 'scss'],
    ['ts', 'typescript'],
    ['tsx', 'typescript'],
    ['vue', 'html'],
    ['xml', 'xml'],
    ['yaml', 'yaml'],
    ['yml', 'yaml'],
  ]).get(name.split('.').at(-1)?.toLowerCase() ?? '') ?? null
}

function toArtifactResource(record: ArtifactRecord): ArtifactResource {
  const { currentPath: _, directoryRoot: __, ...resource } = record
  return resource
}

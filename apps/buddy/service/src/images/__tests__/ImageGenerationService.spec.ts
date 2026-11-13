import type { Model } from '@earendil-works/pi-ai'
import type { CapturedFileWriter } from '../../changes/CapturedFileWriter'
import type { DirectoryGrant } from '../../directories/resolveGrantedPath'
import type { ProviderService } from '../../providers/ProviderService'
import type { ImageGenerationServiceOptions } from '../ImageGenerationService'
import type { ImageOperationEvent } from '../ImageOperationLifecycle'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readImageDiagnostic, readImageFileErrorCode } from '../../../../shared/images/imageGeneration'
import { ArtifactPublicationError } from '../../artifacts/ArtifactService'
import { BuddyDataPaths } from '../../storage/BuddyDataPaths'
import { ImageGenerationError } from '../ImageGenerationGateway'
import { ImageGenerationMaterialStore } from '../ImageGenerationMaterialStore'
import { ImageGenerationService } from '../ImageGenerationService'
import { observeImageDiagnostics } from '../ImageOperationLifecycle'
import { ImageRequestStore } from '../ImageRequestStore'
import { RoutedImageGateway } from '../RoutedImageGateway'
import { createImagePublicationFixture } from './imagePublicationFixture'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4AQEJAPb/AAD/AP//AAD/EPgD/UE7EkoAAAAASUVORK5CYII=', 'base64')
const image = { type: 'image' as const, mimeType: 'image/png', data: 'fixture' }
const model = { provider: 'fixture', id: 'fixture' } as Model<'openai-responses'>

let workspace: string
let publicationRoot: string
let publication: ReturnType<typeof createImagePublicationFixture>
let grants: DirectoryGrant[]

beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'lexora-image-generation-')))
  publicationRoot = await realpath(await mkdtemp(join(tmpdir(), 'lexora-image-publication-')))
  publication = createImagePublicationFixture(publicationRoot)
  grants = [{ canonicalRoot: workspace, root: workspace, kind: 'workspace', grantId: 'workspace-1' }]
})

afterEach(async () => {
  await publication.dispose()
  await rm(publicationRoot, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
})

describe('conversation image generation', () => {
  it.each([' ', 'result.jpg', 'invalid\0.png', 'directory.png', 'parent/result.png'])('rejects an invalid output before submission without changing files: %j', async (outputPath) => {
    await mkdir(join(workspace, 'directory.png'))
    await writeFile(join(workspace, 'parent'), 'unchanged')
    const before = await readdir(workspace)
    const fixture = createGenerationFixture()
    await expect(generate(fixture.service, { outputPath, prompt: 'Create' }, model, new AbortController().signal)).rejects.toMatchObject({ code: 'IMAGE_GENERATION_OUTPUT_UNAVAILABLE', outcome: 'failed', retryable: false, diagnostic: { stage: 'preparing' } })
    expect(fixture.submissions).toBe(0)
    expect(fixture.publications).toBe(0)
    expect(fixture.events.map(event => event.phase)).toEqual(['preparing', 'settled'])
    expect(fixture.events.at(-1)).toMatchObject({ outcome: 'failed', artifactIds: [] })
    expect(await readdir(workspace)).toEqual(before)
    expect(await readFile(join(workspace, 'parent'), 'utf8')).toBe('unchanged')
    await fixture.service.dispose()
  })

  it('uses only the supplied execution grants and permits a corrected authorized absolute output', async () => {
    const fixture = createGenerationFixture()
    const input = { outputPath: join(workspace, 'result.png'), prompt: 'Create' }
    await expect(generate(fixture.service, input, model, new AbortController().signal, [])).rejects.toMatchObject({ code: 'IMAGE_GENERATION_OUTPUT_UNAVAILABLE', outcome: 'failed', cause: { cause: { code: 'PATH_OUTSIDE_GRANTED_DIRECTORY' } } })
    expect(fixture.submissions).toBe(0)
    expect(fixture.publications).toBe(0)
    await expect(generate(fixture.service, input, model, new AbortController().signal, grants)).resolves.toMatchObject({ artifactIds: ['generated-1'] })
    expect(fixture.submissions).toBe(1)
    expect(grants).toHaveLength(1)
    await fixture.service.dispose()
  })

  it.each(['outside', 'dangling'])('rejects a %s symlink before submitting without following it for writes', async (kind) => {
    const allowed = join(workspace, 'allowed')
    const outside = join(workspace, 'outside')
    await mkdir(allowed)
    await mkdir(outside)
    const existing = join(outside, 'result.png')
    await writeFile(existing, png)
    await symlink(kind === 'outside' ? outside : join(workspace, 'missing'), join(allowed, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const fixture = createGenerationFixture()
    await expect(generate(fixture.service, { outputPath: join(allowed, 'linked', 'result.png'), prompt: 'Create' }, model, new AbortController().signal, [{ canonicalRoot: allowed, root: allowed, grantId: 'allowed', kind: 'granted' }])).rejects.toMatchObject({ code: 'IMAGE_GENERATION_OUTPUT_UNAVAILABLE', outcome: 'failed' })
    expect(fixture.submissions).toBe(0)
    expect(fixture.publications).toBe(0)
    expect(await readFile(existing)).toEqual(png)
    await fixture.service.dispose()
  })

  it('accepts a symlink whose canonical destination stays within the execution grants', async () => {
    const target = join(workspace, 'target')
    await mkdir(target)
    await symlink(target, join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const fixture = createGenerationFixture()
    await expect(generate(fixture.service, { outputPath: 'linked/result.png', prompt: 'Create' }, model, new AbortController().signal)).resolves.toMatchObject({ artifactIds: ['generated-1'] })
    expect(fixture.submissions).toBe(1)
    await fixture.service.dispose()
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0).each(['file', 'parent'])('rejects a host read-only %s before submission', async (kind) => {
    const target = join(workspace, kind === 'file' ? 'result.png' : 'locked')
    if (kind === 'file')
      await writeFile(target, png)
    else
      await mkdir(target)
    await chmod(target, kind === 'file' ? 0o400 : 0o500)
    const fixture = createGenerationFixture()
    try {
      await expect(generate(fixture.service, { outputPath: kind === 'file' ? target : join(target, 'missing', 'nested', 'result.png'), prompt: 'Create' }, model, new AbortController().signal)).rejects.toMatchObject({ code: 'IMAGE_GENERATION_OUTPUT_UNAVAILABLE', outcome: 'failed', diagnostic: { stage: 'preparing' }, cause: { cause: { code: 'EACCES' } } })
      expect(fixture.submissions).toBe(0)
      expect(fixture.publications).toBe(0)
      if (kind === 'file')
        expect(await readFile(target)).toEqual(png)
      else
        expect(await readdir(target)).toEqual([])
    }
    finally {
      await chmod(target, kind === 'file' ? 0o600 : 0o700)
      await fixture.service.dispose()
    }
  })

  it('persists preflight failure as unsubmitted and accepts a new corrected request without automatic retry', async () => {
    const paths = new BuddyDataPaths(join(workspace, 'receipts'))
    const requests = new ImageRequestStore(paths)
    const fixture = createGenerationFixture({ requests })
    const runId = randomUUID()
    const signal = new AbortController().signal
    await expect(generate(fixture.service, { outputPath: 'result.jpg', prompt: 'Create' }, model, signal, grants, undefined, { runId, toolCallId: 'invalid' })).rejects.toMatchObject({ code: 'IMAGE_GENERATION_OUTPUT_UNAVAILABLE', outcome: 'failed' })
    expect(fixture.submissions).toBe(0)
    const directory = join(paths.conversationDirectory('conversation-1'), 'image-requests', runId)
    const [name] = await readdir(directory)
    const failed = JSON.parse(await readFile(join(directory, name!), 'utf8'))
    expect(failed).toMatchObject({ state: 'failed', attempts: [], artifactIds: [], responseId: null, failure: { code: 'IMAGE_GENERATION_OUTPUT_UNAVAILABLE', outcome: 'failed', diagnostic: { stage: 'preparing' } } })
    const result = await generate(fixture.service, { outputPath: 'result.png', prompt: 'Create' }, model, signal, grants, undefined, { runId, toolCallId: 'corrected' })
    expect(result.request?.requestId).not.toBe(failed.id)
    expect(fixture.submissions).toBe(1)
    expect(fixture.publications).toBe(1)
    expect(await requests.completed('conversation-1', runId, 'corrected')).toMatchObject({ result: { artifactIds: ['generated-1'] } })
    await fixture.service.dispose()
  })

  it.each(['unknown', 'partial'] as const)('keeps an unresolved %s receipt ahead of a later invalid output preflight', async (failure) => {
    const requests = new ImageRequestStore(new BuddyDataPaths(join(workspace, 'receipts')))
    const fixture = createGenerationFixture({ requests, failure })
    const runId = randomUUID()
    const signal = new AbortController().signal
    await expect(generate(fixture.service, { outputPath: 'result.png', prompt: 'Create' }, model, signal, grants, undefined, { runId, toolCallId: 'original' })).rejects.toMatchObject({ outcome: failure })
    await expect(generate(fixture.service, { outputPath: 'invalid.jpg', prompt: 'Create' }, model, signal, grants, undefined, { runId, toolCallId: 'later' })).rejects.toMatchObject({ code: 'IMAGE_GENERATION_BLOCKED', outcome: failure, diagnostic: { stage: 'blocked' } })
    expect(fixture.submissions).toBe(1)
    await fixture.service.dispose()
  })

  it('does not submit when cancelled before the read-only preflight', async () => {
    const controller = new AbortController()
    const requests = new ImageRequestStore(new BuddyDataPaths(join(workspace, 'receipts')))
    const fixture = createGenerationFixture({ requests: {
      completed: (...args) => requests.completed(...args),
      begin: async (...args) => {
        const begun = await requests.begin(...args)
        controller.abort(new Error('cancelled before preflight'))
        return begun
      },
    } })
    await expect(generate(fixture.service, { outputPath: 'missing/result.png', prompt: 'Create' }, model, controller.signal, grants, undefined, { runId: randomUUID(), toolCallId: 'cancelled' })).rejects.toThrow('cancelled before preflight')
    expect(fixture.submissions).toBe(0)
    expect(fixture.publications).toBe(0)
    expect(fixture.events.at(-1)).toMatchObject({ outcome: 'cancelled', cancellationRequested: true })
    await expect(readFile(join(workspace, 'missing/result.png'))).rejects.toMatchObject({ code: 'ENOENT' })
    await fixture.service.dispose()
  })

  it('settles accepted publication with actual artifacts after cancellation and drains disposal', async () => {
    const controller = new AbortController()
    let release!: () => void
    let started!: () => void
    const publicationStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const source = { listConversationArtifacts: () => [], listForConversation: () => [], materializeConversationImages: async () => ({ images: [], records: [] }) }
    const service = createService({ referenceAccess: { authorize: () => {} }, conversationId: 'conversation-1', cwd: workspace, grants, attachmentService: source, artifactService: { ...source, async registerGeneratedImages() {
      started()

      await gate

      return [{ id: 'generated-1', currentPath: '/workspace/result.png', mimeType: 'image/png' }]
    } }, imageGenerationGateway: { supports: () => true, generate: async () => ({ images: [{ bytes: new Uint8Array(png), mimeType: 'image/png' }], responseId: 'private-response' }) } })
    const events: ImageOperationEvent[] = []
    service.onDidChange(event => events.push(event))
    const pending = generate(service, { outputPath: 'private.png', prompt: 'private prompt' }, model, controller.signal)
    await publicationStarted
    controller.abort()
    let disposed = false
    const stopping = service.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release()
    await expect(pending).resolves.toEqual({ artifactIds: ['generated-1'], outputs: [{ artifactId: 'generated-1', path: '/workspace/result.png', mimeType: 'image/png' }], responseId: 'private-response' })
    await stopping
    expect(events.map(event => event.phase)).toEqual(['preparing', 'processing', 'result-received', 'publishing', 'settled'])
    expect(events.at(-1)).toMatchObject({ outcome: 'completed', cancellationRequested: true, artifactIds: ['generated-1'] })
    expect(Object.isFrozen(events.at(-1)!.artifactIds)).toBe(true)
    expect(JSON.stringify(events)).not.toContain('private')
    await expect(generate(service, { outputPath: 'later.png', prompt: 'later' }, model, controller.signal)).rejects.toThrow('IMAGE_SERVICE_STOPPED')
  })

  it('preserves publication partial effects in image settlement', async () => {
    const source = { listConversationArtifacts: () => [], listForConversation: () => [], materializeConversationImages: async () => ({ images: [], records: [] }) }
    const service = createService({ referenceAccess: { authorize: () => {} }, conversationId: 'conversation-1', cwd: workspace, grants, attachmentService: source, artifactService: { ...source, async registerGeneratedImages() {
      throw new ArtifactPublicationError(new Error('storage failed'), { operationId: 'publication-1', conversationId: 'conversation-1', cause: 'generated', requested: 2, written: 2, unconfirmedWrites: 0, artifactIds: ['generated-1'], stage: 'catalogue', outcome: 'partial' })
    } }, imageGenerationGateway: { supports: () => true, generate: async () => ({ images: [{ bytes: new Uint8Array(png), mimeType: 'image/png' }], responseId: 'private-response' }) } })
    const events: ImageOperationEvent[] = []
    service.onDidChange(event => events.push(event))
    await expect(generate(service, { outputPath: 'private.png', prompt: 'private prompt' }, model, new AbortController().signal)).rejects.toMatchObject({ outcome: 'partial', artifactIds: ['generated-1'], diagnostic: { stage: 'publishing', responseId: 'private-response' }, cause: { receipt: { outcome: 'partial' } } })
    expect(events.at(-1)).toMatchObject({ phase: 'settled', outcome: 'partial', artifactIds: ['generated-1'], publication: { written: 2, operationId: 'publication-1' } })
    await service.dispose()
  })

  it('retains published artifacts when writing the final receipt fails', async () => {
    const source = { listConversationArtifacts: () => [], listForConversation: () => [], materializeConversationImages: async () => ({ images: [], records: [] }) }
    const request = { conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID() }
    let saved: unknown
    const service = createService({ referenceAccess: { authorize: () => {} }, conversationId: request.conversationId, cwd: workspace, grants, attachmentService: source, artifactService: { ...source, registerGeneratedImages: async () => [{ id: 'generated-1', currentPath: '/workspace/result.png', mimeType: 'image/png' }] }, imageGenerationGateway: { supports: () => true, generate: async () => ({ images: [{ bytes: new Uint8Array(png), mimeType: 'image/png' }], responseId: 'response-1' }) }, requests: { completed: async () => null, begin: async () => ({ kind: 'started', receipt: {
      request,
      submitted: false,
      attempt: async () => {},
      submitting: async () => {},
      retain: async () => {},
      complete: async () => { throw new Error('receipt disk failure') },
      fail: async (failure, artifactIds) => { saved = { failure, artifactIds } },
    } }) } })
    await expect(generate(service, { outputPath: 'result.png', prompt: 'Create' }, model, new AbortController().signal, grants, undefined, { runId: request.runId, toolCallId: 'fixture' })).rejects.toMatchObject({ outcome: 'partial', artifactIds: ['generated-1'], request, diagnostic: { stage: 'publishing', responseId: 'response-1' } })
    expect(saved).toMatchObject({ failure: { outcome: 'partial', diagnostic: { responseId: 'response-1' } }, artifactIds: ['generated-1'] })
    await service.dispose()
  })

  it('retains verified originals before a failed publication and returns identical recovery metadata on blocked calls', async () => {
    const paths = new BuddyDataPaths(join(workspace, 'receipts'))
    const requests = new ImageRequestStore(paths)
    const input = { outputPath: 'result.png', prompt: 'private prompt' }
    await writeFile(join(workspace, input.outputPath), 'existing output')
    const fixture = createGenerationFixture({ requests, failure: 'partial', publicationError: Object.assign(new Error(`private path: ${workspace}`), { code: 'EACCES' }) })
    const diagnostics: unknown[] = []
    const observer = observeImageDiagnostics(fixture.service, event => diagnostics.push(event))
    const invocation = { runId: randomUUID(), toolCallId: 'original' }
    const error = await generate(fixture.service, input, model, new AbortController().signal, grants, undefined, invocation).catch(error => error)
    expect(error).toBeInstanceOf(ImageGenerationError)
    expect(error).toMatchObject({ code: 'IMAGE_GENERATION_FAILED', outcome: 'partial', diagnostic: { stage: 'publishing', fileErrorCode: 'EACCES' }, retainedOutputs: [{ mimeType: 'image/png', sizeBytes: png.length, sha256: createHash('sha256').update(png).digest('hex') }] })
    expect(error.diagnostic.transportCode).toBeUndefined()
    const retained = error.retainedOutputs[0]
    expect(retained.path).toContain(join(workspace, '.image-generation', 'conversation-1'))
    expect(await readFile(retained.path)).toEqual(png)
    expect(await readFile(join(workspace, input.outputPath), 'utf8')).toBe('existing output')
    const receiptPath = join(paths.conversationDirectory('conversation-1'), 'image-requests', invocation.runId, `${error.request.requestId}.json`)
    expect(JSON.parse(await readFile(receiptPath, 'utf8'))).toMatchObject({ state: 'partial', retainedOutputs: error.retainedOutputs, failure: { retainedOutputs: error.retainedOutputs } })
    await expect(generate(fixture.service, input, model, new AbortController().signal, grants, undefined, { ...invocation, toolCallId: 'blocked' })).rejects.toMatchObject({ code: 'IMAGE_GENERATION_BLOCKED', outcome: 'partial', request: error.request, retainedOutputs: error.retainedOutputs })
    expect(fixture.submissions).toBe(1)
    expect(fixture.publications).toBe(1)
    expect(JSON.stringify(diagnostics)).not.toContain(workspace)
    expect(JSON.stringify(diagnostics)).not.toContain('private prompt')
    expect(JSON.stringify(diagnostics)).not.toContain('retainedOutputs')
    observer.dispose()
    await fixture.service.dispose()
  })

  it.each(['write-failure', 'cancellation'] as const)('keeps completed originals when later retention is interrupted by %s', async (kind) => {
    const requests = new ImageRequestStore(new BuddyDataPaths(join(workspace, 'receipts')))
    const materials = new ImageGenerationMaterialStore(workspace, 'conversation-1')
    const controller = new AbortController()
    let writes = 0
    const fixture = createGenerationFixture({ requests, imageCount: 2, writeGeneratedImageMaterial: async (image, grants, writeFiles, signal) => {
      if (++writes === 2)
        throw Object.assign(new Error('storage exhausted'), { code: 'ENOSPC' })
      const retained = await materials.write(image, grants, writeFiles, signal)
      if (kind === 'cancellation')
        controller.abort(new Error('cancelled after retained file'))
      return retained
    } })
    const invocation = { runId: randomUUID(), toolCallId: 'original' }
    const error = await generate(fixture.service, { outputPath: 'result.png', prompt: 'Create' }, model, controller.signal, grants, undefined, invocation).catch(error => error)
    expect(error).toMatchObject({ outcome: 'partial', retainedOutputs: [expect.objectContaining({ sizeBytes: png.length })] })
    expect(error.retainedOutputs).toHaveLength(1)
    expect(await readFile(error.retainedOutputs[0].path)).toEqual(png)
    if (kind === 'write-failure')
      expect(error.diagnostic.fileErrorCode).toBe('ENOSPC')
    await expect(requests.begin('conversation-1', invocation.runId, invocation.toolCallId, { fingerprint: 'a'.repeat(64), destination: 'b'.repeat(64) })).rejects.toMatchObject({ retainedOutputs: error.retainedOutputs })
    expect(fixture.submissions).toBe(1)
    expect(fixture.publications).toBe(0)
    await fixture.service.dispose()
  })

  it('keeps a valid generated result partial when the first original cannot be retained', async () => {
    const requests = new ImageRequestStore(new BuddyDataPaths(join(workspace, 'receipts')))
    const fixture = createGenerationFixture({ requests, writeGeneratedImageMaterial: async () => {
      throw Object.assign(new Error('scratch is full'), { code: 'ENOSPC' })
    } })
    const invocation = { runId: randomUUID(), toolCallId: 'original' }
    const input = { outputPath: 'result.png', prompt: 'Create' }
    const error = await generate(fixture.service, input, model, new AbortController().signal, grants, undefined, invocation).catch(error => error)
    expect(error).toMatchObject({ outcome: 'partial', retryable: false, diagnostic: { stage: 'publishing', fileErrorCode: 'ENOSPC' } })
    expect(error.retainedOutputs).toBeUndefined()
    await expect(generate(fixture.service, input, model, new AbortController().signal, grants, undefined, { ...invocation, toolCallId: 'blocked' })).rejects.toMatchObject({ code: 'IMAGE_GENERATION_BLOCKED', outcome: 'partial' })
    expect(fixture.submissions).toBe(1)
    expect(fixture.publications).toBe(0)
    await fixture.service.dispose()
  })

  it('does not hide retained files when both receipt writes fail', async () => {
    const store = new ImageRequestStore(new BuddyDataPaths(join(workspace, 'receipts')))
    const fixture = createGenerationFixture({ requests: {
      completed: (...args) => store.completed(...args),
      begin: async (...args) => {
        const begun = await store.begin(...args)
        if (begun.kind === 'started') {
          begun.receipt.retain = async () => {
            throw Object.assign(new Error('receipt write failed'), { code: 'EROFS' })
          }
          begun.receipt.fail = async () => {
            throw new Error('receipt still unavailable')
          }
        }
        return begun
      },
    } })
    const error = await generate(fixture.service, { outputPath: 'result.png', prompt: 'Create' }, model, new AbortController().signal, grants, undefined, { runId: randomUUID(), toolCallId: 'original' }).catch(error => error)
    expect(error).toMatchObject({ outcome: 'partial', diagnostic: { fileErrorCode: 'EROFS' }, retainedOutputs: [expect.objectContaining({ sizeBytes: png.length })] })
    expect(await readFile(error.retainedOutputs[0].path)).toEqual(png)
    expect(fixture.publications).toBe(0)
    await fixture.service.dispose()
  })

  it.each(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'PATH_OUTSIDE_GRANTED_DIRECTORY', 'FILE_IO_FAILED', 'FILE_PERMISSION_REVOKED', 'FILE_ENGINE_INTERRUPTED'])('classifies local %s errors without copying raw messages or paths to diagnostics', (code) => {
    const native = Object.assign(new Error(`private path: ${workspace}`), { code })
    const wrapped = new ArtifactPublicationError(native, { operationId: 'publication', conversationId: 'conversation-1', cause: 'generated', requested: 1, written: 0, unconfirmedWrites: 0, artifactIds: [], stage: 'file', outcome: 'failed' })
    expect(readImageFileErrorCode(wrapped)).toBe(code)
    expect(readImageDiagnostic({ fileErrorCode: code, message: native.message, stack: native.stack, retainedOutputs: [{ path: workspace }] })).toEqual({ fileErrorCode: code })
    expect(readImageDiagnostic({ fileErrorCode: `${code}: ${workspace}` })).toBeNull()
    expect(readImageFileErrorCode(new Error(`FILE_PERMISSION_REVOKED ${workspace}`))).toBeUndefined()
    expect(readImageFileErrorCode(new Error('FILE_PERMISSION_REVOKED'))).toBe('FILE_PERMISSION_REVOKED')
  })

  it('rejects a missing host material writer before submitting', async () => {
    const fixture = createGenerationFixture({ writeGeneratedImageMaterial: undefined })
    await expect(generate(fixture.service, { outputPath: 'result.png', prompt: 'Create' }, model, new AbortController().signal)).rejects.toMatchObject({ code: 'IMAGE_GENERATION_FAILED', outcome: 'failed', diagnostic: { stage: 'preparing', fileErrorCode: 'IMAGE_MATERIAL_UNAVAILABLE' } })
    expect(fixture.submissions).toBe(0)
    expect(fixture.publications).toBe(0)
    await fixture.service.dispose()
  })

  it('rejects a missing captured publication writer before submitting', async () => {
    const fixture = createGenerationFixture()
    await expect(fixture.service.generate({ outputPath: 'result.png', prompt: 'Create' }, model, new AbortController().signal)).rejects.toMatchObject({ code: 'IMAGE_GENERATION_FAILED', outcome: 'failed', diagnostic: { stage: 'preparing', fileErrorCode: 'IMAGE_MATERIAL_UNAVAILABLE' } })
    expect(fixture.submissions).toBe(0)
    expect(fixture.publications).toBe(0)
    await fixture.service.dispose()
  })

  it('persists only the confirmed original when captured-writer cleanup fails after cancellation', async () => {
    const requests = new ImageRequestStore(new BuddyDataPaths(join(workspace, 'receipts')))
    const fixture = createGenerationFixture({ requests, imageCount: 2 })
    const controller = new AbortController()
    const writeFiles: CapturedFileWriter = async (paths, write) => {
      await publication.writeFiles(paths, write)
      controller.abort(new Error('cancelled during cleanup'))
      throw Object.assign(new Error('release failed'), { code: 'FILE_ENGINE_INTERRUPTED' })
    }
    const invocation = { runId: randomUUID(), toolCallId: 'original' }
    const input = { outputPath: 'result.png', prompt: 'Create' }
    const error = await generate(fixture.service, input, model, controller.signal, grants, writeFiles, invocation).catch(error => error)
    expect(error).toMatchObject({ outcome: 'partial', diagnostic: { fileErrorCode: 'FILE_ENGINE_INTERRUPTED' } })
    expect(error.retainedOutputs).toHaveLength(1)
    expect(await readFile(error.retainedOutputs[0].path)).toEqual(png)
    await expect(generate(fixture.service, input, model, new AbortController().signal, grants, publication.writeFiles, { ...invocation, toolCallId: 'blocked' })).rejects.toMatchObject({ code: 'IMAGE_GENERATION_BLOCKED', outcome: 'partial', retainedOutputs: error.retainedOutputs })
    expect(fixture.submissions).toBe(1)
    expect(fixture.publications).toBe(0)
    await fixture.service.dispose()
  })

  it('keeps a native parent-substitution refusal partial without writing outside the authorized scratch', async () => {
    const requests = new ImageRequestStore(new BuddyDataPaths(join(workspace, 'receipts')))
    const fixture = createGenerationFixture({ requests })
    const directory = join(workspace, '.image-generation', 'conversation-1')
    const backup = join(workspace, '.image-generation', 'original')
    const outside = join(publicationRoot, 'outside')
    await mkdir(directory, { recursive: true })
    await mkdir(outside)
    const mutate = publication.engine.mutate.bind(publication.engine)
    let swapped = false
    vi.spyOn(publication.engine, 'mutate').mockImplementation(async (request) => {
      if (request.action.kind !== 'writeFile')
        return mutate(request)
      await rename(directory, backup)
      await symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir')
      swapped = true
      try {
        return await mutate(request)
      }
      finally {
        await unlink(directory)
        await rename(backup, directory)
      }
    })
    const invocation = { runId: randomUUID(), toolCallId: 'original' }
    const input = { outputPath: 'result.png', prompt: 'Create' }
    const error = await generate(fixture.service, input, model, new AbortController().signal, grants, publication.writeFiles, invocation).catch(error => error)
    expect(error).toMatchObject({ outcome: 'partial', diagnostic: { fileErrorCode: 'FILE_PERMISSION_REVOKED' } })
    expect(error.retainedOutputs).toBeUndefined()
    expect(swapped).toBe(true)
    expect(await readdir(outside)).toEqual([])
    expect(await readdir(directory)).toEqual([])
    await expect(generate(fixture.service, input, model, new AbortController().signal, grants, publication.writeFiles, { ...invocation, toolCallId: 'blocked' })).rejects.toMatchObject({ code: 'IMAGE_GENERATION_BLOCKED', outcome: 'partial' })
    expect(fixture.submissions).toBe(1)
    expect(fixture.publications).toBe(0)
    await fixture.service.dispose()
  })

  it('replays completed work even when references or the selected provider are unavailable', async () => {
    const request = { conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID() }
    const result = { artifactIds: ['generated-1'], outputs: [{ artifactId: 'generated-1', path: '/workspace/result.png', mimeType: 'image/png' }], responseId: 'response-1' }
    const unavailable = async (): Promise<never> => {
      throw new Error('The current provider or reference is unavailable')
    }
    const source = { materializeConversationImages: unavailable }
    const service = createService({ referenceAccess: { authorize: () => {
      throw new Error('Reference is no longer visible')
    } }, conversationId: request.conversationId, cwd: workspace, grants, attachmentService: source, artifactService: { ...source, registerGeneratedImages: unavailable }, imageGenerationGateway: { supports: () => false, generate: unavailable }, requests: { completed: async () => ({ request, result }), begin: unavailable } })
    await expect(service.generate({ outputPath: 'invalid.jpg', prompt: 'Edit', referenceIds: ['unavailable-reference'] }, model, new AbortController().signal, [], undefined, { runId: request.runId, toolCallId: 'fixture' })).resolves.toEqual({ ...result, request })
    await service.dispose()
  })

  it('preserves reference order and uses the last artifact reference for lineage', async () => {
    const references: string[] = []
    let saved: Parameters<ImageGenerationServiceOptions['artifactService']['registerGeneratedImages']>[0] | undefined
    const service = createService({ referenceAccess: { authorize: () => {} }, conversationId: 'conversation-1', cwd: workspace, grants, artifactService: {
      async materializeConversationImages(_conversationId, ids) {
        if (ids?.[0] === 'attachment-1')
          throw Object.assign(new Error('Not an artifact'), { code: 'ARTIFACT_NOT_FOUND' })
        return { images: [{ ...image, data: ids![0]! }], records: [{ id: ids![0]! }] }
      },
      async registerGeneratedImages(input) {
        saved = input
        return [{ id: 'generated-1', currentPath: '/workspace/result.png', mimeType: 'image/png' }]
      },
    }, attachmentService: {
      materializeConversationImages: async () => ({ images: [{ ...image, data: 'attachment-1' }], records: [{ id: 'attachment-1' }] }),
    }, imageGenerationGateway: {
      supports: () => true,
      async generate(input) {
        references.push(...input.inputImages.map(item => item.data))
        return { images: [{ bytes: new Uint8Array(png), mimeType: 'image/png' }], responseId: 'response-1' }
      },
    } })
    await expect(generate(service, { outputPath: ' result.png ', prompt: 'use references', referenceIds: ['artifact-1', 'attachment-1', 'artifact-2'] }, model, new AbortController().signal)).resolves.toEqual({ artifactIds: ['generated-1'], outputs: [{ artifactId: 'generated-1', path: '/workspace/result.png', mimeType: 'image/png' }], responseId: 'response-1' })
    expect(references).toEqual(['artifact-1', 'attachment-1', 'artifact-2'])
    expect(saved).toMatchObject({ sourceArtifactId: 'artifact-2', outputPath: 'result.png', conversationId: 'conversation-1' })
  })

  it.each([
    { images: [], records: [] },
    { images: [image, image], records: [{ id: 'reference-1' }] },
    { images: [image], records: [{ id: 'different-reference' }] },
  ])('rejects missing or mismatched reference material before submission: %j', async (materialized) => {
    let submissions = 0
    const source = { materializeConversationImages: async () => materialized }
    const service = createService({
      conversationId: 'conversation-1',
      cwd: workspace,
      grants,
      referenceAccess: { authorize: () => {} },
      attachmentService: source,
      artifactService: { ...source, registerGeneratedImages: async () => [] },
      imageGenerationGateway: { supports: () => true, generate: async () => {
        submissions++
        return { images: [], responseId: null }
      } },
    })
    await expect(generate(service, { outputPath: 'result.png', prompt: 'Edit', referenceIds: ['reference-1'] }, model, new AbortController().signal)).rejects.toMatchObject({ code: 'IMAGE_GENERATION_REFERENCE_UNAVAILABLE', outcome: 'failed' })
    expect(submissions).toBe(0)
    await service.dispose()
  })

  it('reports inaccessible references as a known failure before sending an image request', async () => {
    const source = { listConversationArtifacts: () => [], listForConversation: () => [], materializeConversationImages: async () => {
      throw Object.assign(new Error('private path and provider body'), { code: 'DIRECTORY_NOT_AUTHORIZED' })
    } }
    let submitted = false
    const service = createService({ referenceAccess: { authorize: () => {} }, conversationId: 'conversation-1', cwd: workspace, grants, attachmentService: source, artifactService: { ...source, registerGeneratedImages: async () => [] }, imageGenerationGateway: { supports: () => true, generate: async () => {
      submitted = true
      return { images: [], responseId: null }
    } } })
    await expect(generate(service, { outputPath: 'result.png', prompt: 'Edit', referenceIds: ['restricted-reference'] }, model, new AbortController().signal)).rejects.toMatchObject({ code: 'IMAGE_GENERATION_REFERENCE_UNAVAILABLE', outcome: 'failed', retryable: false })
    expect(submitted).toBe(false)
  })

  it('publishes a valid opaque image unchanged when requested size and transparency are not met', async () => {
    const source = { listConversationArtifacts: () => [], listForConversation: () => [], materializeConversationImages: async () => ({ images: [], records: [] }) }
    const gateway = new RoutedImageGateway({
      native: { supports: () => true, generate: async () => ({ images: [{ bytes: new Uint8Array(png), mimeType: 'image/png' }], responseId: 'response-different-size' }) },
      providers: { listModels: async () => [] } as unknown as ProviderService,
      preferences: async () => ({ generate: { mode: 'native', target: null, fallbacks: [] } }),
    })
    let published: Uint8Array | undefined
    const service = createService({ referenceAccess: { authorize: () => {} }, conversationId: 'conversation-1', cwd: workspace, grants, attachmentService: source, artifactService: { ...source, registerGeneratedImages: async ({ images }) => {
      published = images[0]!.bytes
      return [{ id: 'generated-1', currentPath: '/workspace/result.png', mimeType: 'image/png' }]
    } }, imageGenerationGateway: gateway })
    const result = await generate(service, { outputPath: 'result.png', prompt: 'Create', output: { size: '1024x1024', background: 'transparent', quality: 'high' } }, model, new AbortController().signal)
    expect(result).toMatchObject({ artifactIds: ['generated-1'], outputs: [{ artifactId: 'generated-1', path: '/workspace/result.png', mimeType: 'image/png' }], responseId: 'response-different-size' })
    expect(Buffer.from(published!)).toEqual(png)
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([2, 1])
  })

  it('rejects a PNG signature without decodable pixels before publication with unknown outcome', async () => {
    const source = { listConversationArtifacts: () => [], listForConversation: () => [], materializeConversationImages: async () => ({ images: [], records: [] }) }
    let published = false
    const service = createService({ referenceAccess: { authorize: () => {} }, conversationId: 'conversation-1', cwd: workspace, grants, attachmentService: source, artifactService: { ...source, registerGeneratedImages: async () => {
      published = true
      return []
    } }, imageGenerationGateway: { supports: () => true, generate: async () => ({ images: [{ bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]), mimeType: 'image/png' }], responseId: null }) } })
    await expect(generate(service, { outputPath: 'result.png', prompt: 'Create' }, model, new AbortController().signal)).rejects.toMatchObject({ code: 'IMAGE_GENERATION_INVALID_RESPONSE', outcome: 'unknown', retryable: false })
    expect(published).toBe(false)
  })

  it.each(['provider', 'publishing'])('does not publish the user output when cancellation precedes publication at %s', async (phase) => {
    const controller = new AbortController()
    let saved = false
    const source = { listConversationArtifacts: () => [], listForConversation: () => [], materializeConversationImages: async () => ({ images: [], records: [] }) }
    const service = createService({ referenceAccess: { authorize: () => {} }, conversationId: 'conversation-1', cwd: workspace, grants, artifactService: {
      ...source,
      async registerGeneratedImages() {
        saved = true
        return [{ id: 'generated-1', currentPath: '/workspace/result.png', mimeType: 'image/png' }]
      },
    }, attachmentService: source, imageGenerationGateway: {
      supports: () => true,
      async generate() {
        if (phase === 'provider')
          controller.abort(new Error('cancelled'))
        return { images: [{ bytes: new Uint8Array(png), mimeType: 'image/png' }], responseId: 'response-1' }
      },
    } })
    service.onDidChange((event) => {
      if (phase === 'publishing' && event.phase === 'publishing')
        controller.abort(new Error('cancelled'))
    })
    const pending = generate(service, { outputPath: 'result.png', prompt: 'generate' }, model, controller.signal)
    if (phase === 'provider')
      await expect(pending).rejects.toThrow('cancelled')
    else
      await expect(pending).rejects.toMatchObject({ outcome: 'partial', retainedOutputs: [expect.objectContaining({ mimeType: 'image/png' })] })
    expect(saved).toBe(false)
  })
})

function generate(service: ImageGenerationService, input: Parameters<ImageGenerationService['generate']>[0], model: Parameters<ImageGenerationService['generate']>[1], signal: AbortSignal, executionGrants = grants, writeFiles: CapturedFileWriter = publication.writeFiles, invocation?: Parameters<ImageGenerationService['generate']>[5]) {
  return service.generate(input, model, signal, executionGrants, writeFiles, invocation)
}

function createService(options: ImageGenerationServiceOptions) {
  const materials = new ImageGenerationMaterialStore(workspace, options.conversationId)
  return new ImageGenerationService({ writeGeneratedImageMaterial: (image, grants, writeFiles, signal) => materials.write(image, grants, writeFiles, signal), ...options })
}

function createGenerationFixture(options: { requests?: ImageGenerationServiceOptions['requests'], failure?: 'unknown' | 'partial', publicationError?: Error, writeGeneratedImageMaterial?: ImageGenerationServiceOptions['writeGeneratedImageMaterial'], imageCount?: number } = {}) {
  let submissions = 0
  let publications = 0
  const events: ImageOperationEvent[] = []
  const source = { materializeConversationImages: async () => ({ images: [], records: [] }) }
  const service = createService({
    conversationId: 'conversation-1',
    cwd: workspace,
    grants,
    requests: options.requests,
    ...('writeGeneratedImageMaterial' in options ? { writeGeneratedImageMaterial: options.writeGeneratedImageMaterial } : {}),
    referenceAccess: { authorize: () => {} },
    attachmentService: source,
    artifactService: { ...source, registerGeneratedImages: async () => {
      publications++
      if (options.failure === 'partial')
        throw new ArtifactPublicationError(options.publicationError ?? new Error('publication interrupted'), { operationId: 'publication-1', conversationId: 'conversation-1', cause: 'generated', requested: 1, written: 0, unconfirmedWrites: 1, artifactIds: [], stage: 'file', outcome: 'partial' })
      return [{ id: 'generated-1', currentPath: join(workspace, 'result.png'), mimeType: 'image/png' }]
    } },
    imageGenerationGateway: { supports: () => true, generate: async (input) => {
      await input.onSubmitting?.()
      submissions++
      if (options.failure === 'unknown')
        throw new ImageGenerationError('IMAGE_GENERATION_FAILED', { outcome: 'unknown' })
      return { images: Array.from({ length: options.imageCount ?? 1 }, () => ({ bytes: png, mimeType: 'image/png' as const })), responseId: 'response-1' }
    } },
  })
  service.onDidChange(event => events.push(event))
  return {
    service,
    events,
    get submissions() { return submissions },
    get publications() { return publications },
  }
}

import type { BuddyCreate, BuddyDefaultUpdate, BuddyMutation, BuddyUpdate, LocalBuddy } from '../../../shared/buddies/buddyApi'
import type { BuddyRepository } from '../storage/buddyRepository'
import { Buffer } from 'node:buffer'
import { BUDDY_AVATAR_MAX_BYTES, buddyCreateSchema, buddyDefaultUpdateSchema, buddyMutationSchema, buddyUpdateSchema } from '../../../shared/buddies/buddyApi'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { runNativeImage } from '../images/runNativeImage'
import { BuddyServiceError, parse } from '../rpc/runtimeRequest'

type BuddyChange = Readonly<{ buddyId: string, catalogRevision: number }>

export class BuddiesService {
  readonly #repository: BuddyRepository
  readonly #changed: Emitter<BuddyChange>
  readonly onDidChange: Emitter<BuddyChange>['event']
  #disposed = false

  constructor(repository: BuddyRepository, onObserverError: (error: unknown) => void = () => {}) {
    this.#repository = repository
    this.#changed = new Emitter(onObserverError)
    this.onDidChange = this.#changed.event
  }

  get defaultBuddyId() {
    return this.#repository.state().defaultBuddyId
  }

  list() {
    return this.#repository.list()
  }

  get(buddyId: string) {
    return this.#repository.get(buddyId)
  }

  async create(input: BuddyCreate, signal?: AbortSignal) {
    this.#check(signal)
    const request = parse(buddyCreateSchema, input)
    await this.#validateAvatar(request.avatar, signal)
    this.#check(signal)
    return this.#changeProfile(() => this.#repository.create(request))
  }

  async update(input: BuddyUpdate, signal?: AbortSignal) {
    this.#check(signal)
    const request = parse(buddyUpdateSchema, input)
    const before = this.get(request.buddyId)
    if (before.deletedAt)
      throw new BuddyServiceError('BUDDY_DELETED')
    if (before.revision !== request.expectedRevision)
      throw new BuddyServiceError('BUDDY_CONFLICT')
    await this.#validateAvatar(request.avatar, signal)
    this.#check(signal)
    return this.#changeProfile(() => this.#repository.update(request))
  }

  delete(input: BuddyMutation, signal?: AbortSignal) {
    this.#check(signal)
    const request = parse(buddyMutationSchema, input)
    return this.#changeProfile(() => this.#repository.delete(request))
  }

  resetProfile(input: BuddyMutation, signal?: AbortSignal) {
    this.#check(signal)
    const request = parse(buddyMutationSchema, input)
    return this.#changeProfile(() => this.#repository.resetProfile(request))
  }

  setDefault(input: BuddyDefaultUpdate, signal?: AbortSignal) {
    this.#check(signal)
    const request = parse(buddyDefaultUpdateSchema, input)
    const before = this.#repository.state().revision
    const catalog = this.#repository.setDefault(request)
    this.#publish(request.buddyId, before)
    return catalog
  }

  #changeProfile(operation: () => LocalBuddy) {
    const before = this.#repository.state().revision
    const buddy = operation()
    this.#publish(buddy.id, before)
    return buddy
  }

  #publish(buddyId: string, before: number) {
    const catalogRevision = this.#repository.state().revision
    if (catalogRevision !== before)
      this.#changed.fire(copyEventSnapshot({ buddyId, catalogRevision }))
  }

  #check(signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (this.#disposed)
      throw new BuddyServiceError('RUNTIME_UNAVAILABLE')
  }

  async #validateAvatar(avatar: string | null | undefined, signal?: AbortSignal) {
    if (!avatar)
      return
    const [header, data] = avatar.split(',')
    const bytes = Buffer.from(data!, 'base64')
    if (bytes.length > BUDDY_AVATAR_MAX_BYTES || bytes.toString('base64') !== data)
      throw new BuddyServiceError('VALIDATION_FAILED')
    try {
      await runNativeImage(bytes, { operation: 'validate', options: { mimeType: header!.slice(5, -7) } }, signal)
    }
    catch {
      signal?.throwIfAborted()
      throw new BuddyServiceError('VALIDATION_FAILED')
    }
  }

  dispose() {
    this.#disposed = true
    this.#changed.dispose()
  }
}

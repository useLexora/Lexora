import type { AuthEvent, AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai'
import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type { ProviderAuthChallenge } from './providerSchemas'
import { randomUUID } from 'node:crypto'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { providerAuthChallengeSchema } from './providerSchemas'

export interface AuthInteractionServiceOptions {
  openExternal?: (url: string) => Promise<void>
}
export interface LoginInteractionHandle {
  interaction: AuthInteraction
  loginId: string
}
export interface AuthInteractionChange {
  readonly revision: number
  readonly loginId: string
  readonly providerId: string
  readonly kind: 'started' | 'challenge-opened' | 'challenge-closed' | 'ended'
  readonly challengeId?: string
  readonly challengeType?: ProviderAuthChallenge['type']
  readonly outcome?: 'responded' | 'cancelled' | 'completed' | 'failed'
}
interface LoginSession {
  challenges: Map<string, ProviderAuthChallenge['type']>
  controller: AbortController
  providerId: string
}
interface PendingPrompt {
  loginId: string
  prompt: AuthPrompt
  dispose: () => void
  reject: (error: Error) => void
  resolve: (value: string) => void
}

export class AuthInteractionService {
  readonly #changes = new Emitter<AuthInteractionChange>(() => console.error('AUTH_INTERACTION_OBSERVER_FAILED'))
  readonly #challenges = new Emitter<EventSnapshot<ProviderAuthChallenge>>(() => console.error('AUTH_CHALLENGE_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  readonly onDidChallenge = this.#challenges.event
  readonly #openExternal?: AuthInteractionServiceOptions['openExternal']
  readonly #sessions = new Map<string, LoginSession>()
  readonly #challengeSessions = new Map<string, string>()
  readonly #pendingPrompts = new Map<string, PendingPrompt>()
  #revision = 0
  #disposed = false

  constructor(options: AuthInteractionServiceOptions = {}) {
    this.#openExternal = options.openExternal
  }

  get snapshot() {
    return copyEventSnapshot({ revision: this.#revision, logins: [...this.#sessions].map(([loginId, session]) => ({ loginId, providerId: session.providerId, challenges: [...session.challenges].map(([challengeId, type]) => ({ challengeId, type })) })) })
  }

  beginLogin(providerId: string): LoginInteractionHandle {
    if (this.#disposed)
      throw new ProviderLoginCancelledError()
    const loginId = randomUUID()
    const session: LoginSession = { challenges: new Map(), controller: new AbortController(), providerId }
    this.#sessions.set(loginId, session)
    this.#publish({ loginId, providerId, kind: 'started' })
    return { loginId, interaction: {
      signal: session.controller.signal,
      notify: event => this.#handleEvent(loginId, event),
      prompt: prompt => this.#handlePrompt(loginId, prompt),
    } }
  }

  completeLogin(loginId: string, outcome: 'cancelled' | 'completed' | 'failed' = 'completed'): void {
    const session = this.#sessions.get(loginId)
    if (!session)
      return
    this.#sessions.delete(loginId)
    const changes: AuthInteractionChange[] = []
    for (const [challengeId, challengeType] of session.challenges) {
      this.#challengeSessions.delete(challengeId)
      const pending = this.#pendingPrompts.get(challengeId)
      this.#pendingPrompts.delete(challengeId)
      pending?.dispose()
      pending?.reject(new ProviderLoginCancelledError())
      changes.push({ revision: ++this.#revision, loginId, providerId: session.providerId, kind: 'challenge-closed', challengeId, challengeType, outcome })
    }
    session.challenges.clear()
    session.controller.abort(new ProviderLoginCancelledError())
    changes.push({ revision: ++this.#revision, loginId, providerId: session.providerId, kind: 'ended', outcome })
    this.#changes.fireBatch(changes.map(change => Object.freeze(change)))
  }

  respondToPrompt(challengeId: string, value: string): void {
    const pending = this.#pendingPrompts.get(challengeId)
    if (!pending)
      throw new UnknownAuthChallengeError()
    if (pending.prompt.type === 'select' && !pending.prompt.options.some(option => option.id === value))
      throw new InvalidAuthChallengeResponseError()
    this.#finishPrompt(challengeId, 'responded', value)
  }

  cancelLogin(challengeId: string): void {
    const loginId = this.#challengeSessions.get(challengeId)
    if (!loginId || !this.#sessions.has(loginId))
      throw new UnknownAuthChallengeError()
    this.completeLogin(loginId, 'cancelled')
  }

  dispose(): void {
    this.#disposed = true
    for (const loginId of this.#sessions.keys()) this.completeLogin(loginId, 'cancelled')
    this.#changes.dispose()
    this.#challenges.dispose()
  }

  #handlePrompt(loginId: string, prompt: AuthPrompt): Promise<string> {
    const session = this.#requireSession(loginId)
    if (prompt.signal?.aborted)
      return Promise.reject(new ProviderLoginCancelledError())
    const challengeId = randomUUID()
    const challenge = providerAuthChallengeSchema.parse({
      challengeId,
      providerId: session.providerId,
      type: prompt.type,
      message: prompt.message,
      ...('placeholder' in prompt ? { placeholder: prompt.placeholder } : {}),
      ...(prompt.type === 'select' ? { options: prompt.options } : {}),
    })
    const response = new Promise<string>((resolve, reject) => {
      const abort = () => this.#finishPrompt(challengeId, 'cancelled')
      const dispose = () => {
        session.controller.signal.removeEventListener('abort', abort)
        prompt.signal?.removeEventListener('abort', abort)
      }
      const owned = prompt.type === 'select' ? { ...prompt, options: prompt.options.map(option => ({ ...option })) } : prompt
      this.#pendingPrompts.set(challengeId, { loginId, prompt: owned, reject, resolve, dispose })
      session.controller.signal.addEventListener('abort', abort, { once: true })
      prompt.signal?.addEventListener('abort', abort, { once: true })
    })
    this.#registerChallenge(loginId, session, challenge)
    return response
  }

  #handleEvent(loginId: string, event: AuthEvent): void {
    const session = this.#requireSession(loginId)
    const challenge = toChallenge(randomUUID(), session.providerId, event)
    this.#registerChallenge(loginId, session, challenge)
    const url = event.type === 'auth_url' ? event.url : event.type === 'device_code' ? event.verificationUri : null
    if (url && this.#openExternal && this.#sessions.get(loginId) === session)
      void this.#openExternal(url).catch(() => {})
  }

  #registerChallenge(loginId: string, session: LoginSession, challenge: ProviderAuthChallenge): void {
    session.challenges.set(challenge.challengeId, challenge.type)
    this.#challengeSessions.set(challenge.challengeId, loginId)
    this.#publish({ loginId, providerId: session.providerId, kind: 'challenge-opened', challengeId: challenge.challengeId, challengeType: challenge.type })
    if (this.#challengeSessions.has(challenge.challengeId))
      this.#challenges.fire(copyEventSnapshot(challenge))
  }

  #finishPrompt(challengeId: string, outcome: 'responded' | 'cancelled', value?: string): void {
    const pending = this.#pendingPrompts.get(challengeId)
    if (!pending)
      return
    this.#pendingPrompts.delete(challengeId)
    this.#challengeSessions.delete(challengeId)
    const session = this.#sessions.get(pending.loginId)
    session?.challenges.delete(challengeId)
    pending.dispose()
    if (outcome === 'responded')
      pending.resolve(value!)
    else pending.reject(new ProviderLoginCancelledError())
    if (session)
      this.#publish({ loginId: pending.loginId, providerId: session.providerId, kind: 'challenge-closed', challengeId, challengeType: pending.prompt.type, outcome })
  }

  #requireSession(loginId: string): LoginSession {
    const session = this.#sessions.get(loginId)
    if (!session)
      throw new ProviderLoginCancelledError()
    return session
  }

  #publish(change: Omit<AuthInteractionChange, 'revision'>): void {
    this.#changes.fire(Object.freeze({ ...change, revision: ++this.#revision }))
  }
}

export class ProviderLoginCancelledError extends Error {
  readonly code = 'PROVIDER_LOGIN_CANCELLED'

  constructor() {
    super('Lexora Buddy provider login was cancelled')
    this.name = 'ProviderLoginCancelledError'
  }
}

export class UnknownAuthChallengeError extends Error {
  readonly code = 'AUTH_CHALLENGE_NOT_FOUND'

  constructor() {
    super('Lexora Buddy provider authentication challenge was not found')
    this.name = 'UnknownAuthChallengeError'
  }
}

export class InvalidAuthChallengeResponseError extends Error {
  readonly code = 'VALIDATION_FAILED'

  constructor() {
    super('Lexora Buddy provider authentication response is invalid')
    this.name = 'InvalidAuthChallengeResponseError'
  }
}

function toChallenge(
  challengeId: string,
  providerId: string,
  event: AuthEvent,
): ProviderAuthChallenge {
  switch (event.type) {
    case 'auth_url':
      return providerAuthChallengeSchema.parse({
        challengeId,
        providerId,
        type: event.type,
        url: event.url,
        instructions: event.instructions,
      })
    case 'device_code':
      return providerAuthChallengeSchema.parse({
        challengeId,
        providerId,
        type: event.type,
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        intervalSeconds: event.intervalSeconds,
        expiresInSeconds: event.expiresInSeconds,
      })
    case 'info':
      return providerAuthChallengeSchema.parse({
        challengeId,
        providerId,
        type: event.type,
        message: event.message,
        links: event.links,
      })
    case 'progress':
      return providerAuthChallengeSchema.parse({
        challengeId,
        providerId,
        type: event.type,
        message: event.message,
      })
  }
}

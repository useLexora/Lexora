import { describe, expect, it } from 'vitest'
import { AuthInteractionService } from '../AuthInteractionService'

describe('authentication interaction lifetime', () => {
  it('keeps a prompt response independent of passive observers and removes abort listeners', async () => {
    const service = new AuthInteractionService()
    const changes: string[] = []
    service.onDidChange(event => changes.push(event.kind))
    service.onDidChallenge(event => service.respondToPrompt(event.challengeId, 'fixture-response'))
    const login = service.beginLogin('fixture')
    const signal = new AbortController()
    const response = login.interaction.prompt({ type: 'secret', message: 'Fixture', signal: signal.signal })
    await expect(response).resolves.toBe('fixture-response')
    signal.abort()
    service.completeLogin(login.loginId)
    service.completeLogin(login.loginId)
    expect(changes).toEqual(['started', 'challenge-opened', 'challenge-closed', 'ended'])
    expect(service.snapshot.logins).toEqual([])
    expect(JSON.stringify(service.snapshot)).not.toContain('fixture-response')
    service.dispose()
  })

  it('owns selection inputs and cancels outstanding prompts exactly once on disposal', async () => {
    const service = new AuthInteractionService()
    const login = service.beginLogin('fixture')
    const options = [{ id: 'original', label: 'Original' }]
    let challengeId = ''
    service.onDidChallenge((event) => {
      challengeId = event.challengeId
    })
    const first = login.interaction.prompt({ type: 'select', message: 'Fixture', options })
    options[0]!.id = 'changed'
    expect(() => service.respondToPrompt(challengeId, 'changed')).toThrow()
    service.respondToPrompt(challengeId, 'original')
    await expect(first).resolves.toBe('original')
    const second = login.interaction.prompt({ type: 'text', message: 'Fixture' })
    const cancelled = expect(second).rejects.toMatchObject({ code: 'PROVIDER_LOGIN_CANCELLED' })
    service.dispose()
    await cancelled
    expect(login.interaction.signal?.aborted).toBe(true)
    expect(service.snapshot.logins).toEqual([])
  })
})

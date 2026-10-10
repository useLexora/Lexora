import type { SandboxEnvironmentStatus, SandboxSetupResult } from '@buddy-shared/permissions/shellSandbox'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, shallowRef } from 'vue'
import { useShellSandboxStatus } from '../useShellSandboxStatus'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => {
  for (const scope of scopes.splice(0))
    scope.stop()
})

async function fixture() {
  const api = {
    getSandboxStatus: vi.fn<() => Promise<SandboxEnvironmentStatus>>().mockResolvedValue('needs_setup'),
    setupSandbox: vi.fn<() => Promise<SandboxSetupResult>>(),
  }
  vi.stubGlobal('window', { lexoraDesktop: { app: api } })
  const scope = effectScope()
  scopes.push(scope)
  const open = shallowRef(false)
  const state = scope.run(() => useShellSandboxStatus(open))!
  await vi.waitFor(() => expect(state.availability.value.status).toBe('needs_setup'))
  return { api, scope, open, state }
}

describe('sandbox setup feedback', () => {
  it.each([
    ['ready', 'available'],
    ['incompatible', 'incompatible'],
  ] as const)('applies verified %s immediately without waiting for a second check', async (result, status) => {
    const { api, state } = await fixture()
    const install = deferred<SandboxSetupResult>()
    api.setupSandbox.mockReturnValue(install.promise)
    api.getSandboxStatus.mockReturnValue(deferred<SandboxEnvironmentStatus>().promise)
    const pending = state.setup()
    expect(state.isSettingUp.value).toBe(true)
    await expect(state.setup()).resolves.toBeUndefined()
    install.resolve(result)
    await expect(pending).resolves.toBe(result)
    expect(state.availability.value.status).toBe(status)
    expect(state.isSettingUp.value).toBe(false)
    expect(state.setupResult.value).toBe(result)
    expect(api.setupSandbox).toHaveBeenCalledTimes(1)
  })

  it.each(['cancelled', 'busy', 'failed'] as const)('keeps loading throughout the status check after %s and allows retry afterward', async (result) => {
    const { api, state } = await fixture()
    const check = deferred<SandboxEnvironmentStatus>()
    api.setupSandbox.mockResolvedValueOnce(result).mockResolvedValueOnce('ready')
    api.getSandboxStatus.mockReturnValue(check.promise)
    const pending = state.setup()
    await vi.waitFor(() => expect(state.isChecking.value).toBe(true))
    expect(state.isSettingUp.value).toBe(true)
    await expect(state.setup()).resolves.toBeUndefined()
    check.resolve('needs_setup')
    await pending
    expect(state.isSettingUp.value).toBe(false)
    expect(state.setupResult.value).toBe(result)
    await expect(state.setup()).resolves.toBe('ready')
    expect(state.availability.value.ready).toBe(true)
  })

  it('retains loading while reconciling a rejected installation request', async () => {
    const { api, state } = await fixture()
    const check = deferred<SandboxEnvironmentStatus>()
    api.setupSandbox.mockRejectedValue(new Error('IPC disconnected'))
    api.getSandboxStatus.mockReturnValue(check.promise)
    const pending = state.setup()
    await vi.waitFor(() => expect(state.isChecking.value).toBe(true))
    expect(state.isSettingUp.value).toBe(true)
    check.resolve('needs_repair')
    await pending
    expect(state.isSettingUp.value).toBe(false)
    expect(state.setupResult.value).toBe('failed')
    expect(state.availability.value.action).toBe('repair')
  })

  it('discards an older check that finishes after a successful installation', async () => {
    const { api, state, open } = await fixture()
    const check = deferred<SandboxEnvironmentStatus>()
    api.getSandboxStatus.mockReturnValue(check.promise)
    open.value = true
    await nextTick()
    expect(state.isChecking.value).toBe(true)
    api.setupSandbox.mockResolvedValue('ready')
    await state.setup()
    check.resolve('needs_repair')
    await nextTick()
    expect(state.availability.value.status).toBe('available')
    expect(state.isChecking.value).toBe(false)
  })

  it('does not publish a late installation result after leaving the view', async () => {
    const { api, scope, state } = await fixture()
    const install = deferred<SandboxSetupResult>()
    api.setupSandbox.mockReturnValue(install.promise)
    const pending = state.setup()
    scope.stop()
    install.resolve('ready')
    await expect(pending).resolves.toBeUndefined()
    expect(state.availability.value.status).toBe('needs_setup')
    expect(state.setupResult.value).toBeUndefined()
  })
})

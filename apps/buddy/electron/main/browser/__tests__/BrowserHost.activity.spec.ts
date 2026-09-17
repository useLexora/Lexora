import { deferred } from '@buddy-tests/deferred'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BROWSER_PREFERENCES } from '../../../../shared/browser/browserPreferences'
import { configureSemanticObservation, createFixture } from './browserHostFixture'

const FREEZE_DELAY_MS = DEFAULT_BROWSER_PREFERENCES.freezeDelaySeconds * 1000

const cleanups: Array<() => void> = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  vi.useRealTimers()
})

function setup() {
  let taskLinked = true
  let preferences = { ...DEFAULT_BROWSER_PREFERENCES }
  const fixture = createFixture({ getFreezeDelay: visible => taskLinked && (visible ? preferences.freezeForeground : preferences.freezeBackground) ? preferences.freezeDelaySeconds * 1000 : null })
  cleanups.push(() => fixture.host.dispose())
  return {
    ...fixture,
    setPreferences: async (patch: Partial<typeof preferences>) => {
      preferences = { ...preferences, ...patch }
      await fixture.host.updateActivity()
    },
    setTaskLinked: async (enabled: boolean) => {
      taskLinked = enabled
      await fixture.host.updateActivity()
    },
  }
}

describe('browser page activity', () => {
  it('freezes only background task pages and resumes all pages in independent mode', async () => {
    const fixture = setup()
    const first = fixture.host.ensureSession(null, 'first')
    const second = fixture.host.ensureSession(null, 'second')
    fixture.host.setSurface({ sessionId: first.sessionId, visible: true })
    await vi.advanceTimersByTimeAsync(FREEZE_DELAY_MS)
    expect(fixture.webContentsInstances.map(page => page.lifecycleState)).toEqual(['active', 'frozen'])
    fixture.host.setSurface({ sessionId: second.sessionId, visible: true })
    await fixture.host.updateActivity()
    expect(fixture.webContentsInstances.map(page => page.lifecycleState)).toEqual(['active', 'active'])
    await vi.advanceTimersByTimeAsync(FREEZE_DELAY_MS)
    expect(fixture.webContentsInstances.map(page => page.lifecycleState)).toEqual(['frozen', 'active'])

    await fixture.setTaskLinked(false)
    fixture.host.setSurface({ sessionId: second.sessionId, visible: false })
    await vi.advanceTimersByTimeAsync(FREEZE_DELAY_MS * 2)
    expect(fixture.webContentsInstances.map(page => page.lifecycleState)).toEqual(['active', 'active'])
    await fixture.setTaskLinked(true)
    await vi.advanceTimersByTimeAsync(FREEZE_DELAY_MS)
    expect(fixture.webContentsInstances.map(page => page.lifecycleState)).toEqual(['frozen', 'frozen'])
  })

  it('keeps loading, audible and agent-controlled pages running', async () => {
    const fixture = setup()
    const state = fixture.host.ensureSession('conversation')
    const page = fixture.webContentsInstances[0]!
    page.emit('did-start-loading')
    await vi.advanceTimersByTimeAsync(FREEZE_DELAY_MS)
    expect(page.lifecycleState).toBe('active')
    page.audible = true
    page.currentUrl = 'https://example.com/'
    page.emit('did-navigate', {}, page.currentUrl)
    page.emit('did-stop-loading')
    page.emit('audio-state-changed')
    await vi.advanceTimersByTimeAsync(FREEZE_DELAY_MS)
    expect(page.lifecycleState).toBe('active')
    page.audible = false
    page.emit('audio-state-changed')
    await vi.advanceTimersByTimeAsync(FREEZE_DELAY_MS)
    expect(page.lifecycleState).toBe('frozen')
    const lease = fixture.host.acquireControl({ sessionId: state.sessionId, pageId: state.pageId })
    await fixture.host.updateActivity()
    await vi.advanceTimersByTimeAsync(FREEZE_DELAY_MS)
    expect(page.lifecycleState).toBe('active')
    fixture.host.releaseControl(lease)
    await vi.advanceTimersByTimeAsync(FREEZE_DELAY_MS)
    expect(page.lifecycleState).toBe('frozen')
  })

  it('keeps an in-flight observation running and starts the idle period after it finishes', async () => {
    const fixture = setup()
    const state = fixture.host.ensureSession(null, 'first')
    const page = fixture.webContentsInstances[0]!
    const lifecycleCommand = page.debugger.sendCommand.getMockImplementation()!
    configureSemanticObservation(page)
    const semanticCommand = page.debugger.sendCommand.getMockImplementation()!
    const reading = deferred<void>()
    page.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Page.setWebLifecycleState')
        return lifecycleCommand(method, params)
      if (method === 'Accessibility.getFullAXTree')
        await reading.promise
      return semanticCommand(method, params)
    })
    await vi.advanceTimersByTimeAsync(FREEZE_DELAY_MS)
    expect(page.lifecycleState).toBe('frozen')
    const observing = fixture.host.observe({ sessionId: state.sessionId, pageId: state.pageId })
    await vi.advanceTimersByTimeAsync(FREEZE_DELAY_MS * 2)
    expect(page.lifecycleState).toBe('active')
    reading.resolve()
    const observation = await observing
    expect(observation.elements.length).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(FREEZE_DELAY_MS - 1)
    expect(page.lifecycleState).toBe('active')
    await vi.advanceTimersByTimeAsync(1)
    expect(page.lifecycleState).toBe('frozen')
  })

  it('resets foreground idle time on input and selection, and applies policy changes immediately', async () => {
    const fixture = setup()
    const state = fixture.host.ensureSession(null, 'first')
    const page = fixture.webContentsInstances[0]!
    fixture.host.setSurface({ sessionId: state.sessionId, visible: true })
    await fixture.setPreferences({ freezeForeground: true })
    await vi.advanceTimersByTimeAsync(FREEZE_DELAY_MS - 1)
    page.emit('before-input-event', { preventDefault: vi.fn() }, { type: 'keyDown', key: 'a' })
    await vi.advanceTimersByTimeAsync(FREEZE_DELAY_MS - 1)
    expect(page.lifecycleState).toBe('active')
    await vi.advanceTimersByTimeAsync(1)
    expect(page.lifecycleState).toBe('frozen')
    page.emit('before-mouse-event', {}, { type: 'mouseMove' })
    await fixture.host.updateActivity()
    expect(page.lifecycleState).toBe('active')
    await vi.advanceTimersByTimeAsync(FREEZE_DELAY_MS)
    expect(page.lifecycleState).toBe('frozen')
    await fixture.setPreferences({ freezeForeground: false })
    expect(page.lifecycleState).toBe('active')

    fixture.host.setSurface({ sessionId: state.sessionId, visible: false })
    await vi.advanceTimersByTimeAsync(FREEZE_DELAY_MS - 1)
    await fixture.setPreferences({ freezeDelaySeconds: 120 })
    await vi.advanceTimersByTimeAsync(FREEZE_DELAY_MS)
    expect(page.lifecycleState).toBe('active')
    await vi.advanceTimersByTimeAsync(FREEZE_DELAY_MS)
    expect(page.lifecycleState).toBe('frozen')
    await fixture.setPreferences({ freezeForeground: true })
    fixture.host.setSurface({ sessionId: state.sessionId, visible: true })
    await fixture.host.updateActivity()
    expect(page.lifecycleState).toBe('active')
    await fixture.setPreferences({ freezeForeground: false, freezeBackground: false })
    fixture.host.setSurface({ sessionId: state.sessionId, visible: false })
    await vi.advanceTimersByTimeAsync(FREEZE_DELAY_MS * 3)
    expect(page.lifecycleState).toBe('active')
  })

  it('finishes a pending freeze before restoring a quickly reactivated page', async () => {
    const fixture = setup()
    const state = fixture.host.ensureSession(null, 'first')
    const page = fixture.webContentsInstances[0]!
    const freeze = deferred<void>()
    page.debugger.sendCommand.mockImplementation(async (_method, params) => {
      if (params?.state === 'frozen')
        await freeze.promise
      page.lifecycleState = params?.state as 'active' | 'frozen'
      return {}
    })
    await vi.advanceTimersByTimeAsync(FREEZE_DELAY_MS)
    fixture.host.setSurface({ sessionId: state.sessionId, visible: true })
    freeze.resolve()
    await fixture.host.updateActivity()
    expect(page.lifecycleState).toBe('active')
    fixture.host.setSurface({ sessionId: state.sessionId, visible: false })
    fixture.host.close(state.sessionId)
    await vi.advanceTimersByTimeAsync(FREEZE_DELAY_MS)
    expect(page.lifecycleState).toBe('active')
    expect(page.debuggerAttached).toBe(false)
  })
})

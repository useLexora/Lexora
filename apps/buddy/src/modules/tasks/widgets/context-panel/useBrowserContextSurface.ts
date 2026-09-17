import type {
  DesktopBrowserApi,
  DesktopBrowserProfileMode,
  DesktopBrowserState,
} from '@buddy-electron/shared/desktopApi'
import type { BrowserScreenshotResult } from '@buddy-shared/browser/browserDesktopApi'
import type { Ref } from 'vue'
import type { DesktopBrowserGuestSurfaceHost } from '@/platform/browser/browserGuestSurface'
import { computed, onBeforeUnmount, onMounted, readonly, shallowRef, watch } from 'vue'
import { normalizeBrowserAddress } from './browserAddress'
import { useBrowserSurface } from './useBrowserSurface'

interface UseBrowserContextSurfaceOptions {
  sessionReady: (state: DesktopBrowserState, tabId?: string) => void
  state: Readonly<Ref<DesktopBrowserState | null>>
  updateState: (state: DesktopBrowserState) => void
  enabled?: Readonly<Ref<boolean>>
  visible?: Readonly<Ref<boolean>>
  tabId?: Readonly<Ref<string | undefined>>
  api: DesktopBrowserApi
  conversationId: Readonly<Ref<string | null>>
  guestHost: DesktopBrowserGuestSurfaceHost
  surfaceElement: Readonly<Ref<HTMLElement | null>>
}

export function useBrowserContextSurface(options: UseBrowserContextSurfaceOptions) {
  const state = options.state
  const failed = shallowRef(false)
  const isLoading = computed(() => state.value?.status === 'loading')
  const isCapturingScreenshot = shallowRef(false)
  const isSettingZoom = shallowRef(false)
  const isOpeningExternal = shallowRef(false)
  const isShowingFileInFolder = shallowRef(false)
  const isSwitchingProfile = shallowRef(false)
  const isTakingControl = shallowRef(false)
  let lifecycle = 0
  let mounted = false
  let stateRequest = 0
  let stateVersion = 0
  watch(options.state, () => {
    stateVersion += 1
  }, { flush: 'sync' })

  onMounted(() => {
    mounted = true
    const currentLifecycle = ++lifecycle
    void ensureSession(currentLifecycle)
  })

  onBeforeUnmount(() => {
    mounted = false
    lifecycle += 1
  })

  useBrowserSurface({
    api: options.api,
    element: options.surfaceElement,
    visible: options.visible,
    guestHost: options.guestHost,
    sessionId: computed(() => state.value?.sessionId ?? null),
  })
  watch([options.conversationId, () => options.tabId?.value, () => options.enabled?.value], () => {
    lifecycle += 1
    isCapturingScreenshot.value = false
    isSettingZoom.value = false
    isOpeningExternal.value = false
    isShowingFileInFolder.value = false
    isSwitchingProfile.value = false
    isTakingControl.value = false
    if (mounted)
      void ensureSession(lifecycle)
  }, { flush: 'sync' })

  async function ensureSession(currentLifecycle: number): Promise<void> {
    if (options.enabled?.value === false)
      return
    failed.value = false
    const version = stateVersion
    const tabId = options.tabId?.value
    try {
      const nextState = await options.api.ensureSession(options.conversationId.value, tabId)
      options.sessionReady(nextState, tabId)
      if (!mounted || lifecycle !== currentLifecycle)
        return
      if (stateVersion === version)
        options.updateState(nextState)
    }
    catch {
      if (mounted && lifecycle === currentLifecycle)
        failed.value = true
    }
  }

  async function navigate(rawAddress: string): Promise<boolean> {
    const sessionId = state.value?.sessionId
    const url = normalizeBrowserAddress(rawAddress)
    if (!url)
      return false
    if (!sessionId)
      return false
    try {
      return await updateSessionState(sessionId, () => options.api.navigate(sessionId, url))
    }
    catch {
      return false
    }
  }

  async function captureScreenshot(): Promise<BrowserScreenshotResult | 'failed'> {
    const sessionId = state.value?.sessionId
    if (!sessionId || isCapturingScreenshot.value)
      return 'canceled'
    const currentLifecycle = lifecycle
    isCapturingScreenshot.value = true
    try {
      const result = await options.api.captureScreenshot(sessionId)
      return mounted && lifecycle === currentLifecycle ? result : 'canceled'
    }
    catch {
      return mounted && lifecycle === currentLifecycle ? 'failed' : 'canceled'
    }
    finally {
      if (mounted && lifecycle === currentLifecycle)
        isCapturingScreenshot.value = false
    }
  }

  async function setZoomFactor(factor: number | null): Promise<boolean> {
    const sessionId = state.value?.sessionId
    if (!sessionId || isSettingZoom.value)
      return false
    const currentLifecycle = lifecycle
    isSettingZoom.value = true
    try {
      return await updateSessionState(sessionId, () => options.api.setZoomFactor(sessionId, factor))
    }
    catch {
      return false
    }
    finally {
      if (mounted && lifecycle === currentLifecycle)
        isSettingZoom.value = false
    }
  }

  async function openExternal(): Promise<boolean> {
    const sessionId = state.value?.sessionId
    if (!sessionId || isOpeningExternal.value)
      return false
    const currentLifecycle = lifecycle
    isOpeningExternal.value = true
    try {
      const opened = await options.api.openExternal(sessionId)
      return mounted && lifecycle === currentLifecycle && opened
    }
    catch {
      return false
    }
    finally {
      if (mounted && lifecycle === currentLifecycle)
        isOpeningExternal.value = false
    }
  }

  async function setProfileMode(profileMode: DesktopBrowserProfileMode): Promise<boolean> {
    const sessionId = state.value?.sessionId
    if (
      !sessionId
      || state.value?.profileMode === profileMode
      || isSwitchingProfile.value
    ) {
      return false
    }
    const currentLifecycle = lifecycle
    isSwitchingProfile.value = true
    try {
      return await updateSessionState(sessionId, () => options.api.setProfileMode(sessionId, profileMode))
    }
    catch {
      return false
    }
    finally {
      if (mounted && lifecycle === currentLifecycle)
        isSwitchingProfile.value = false
    }
  }

  async function showFileInFolder(): Promise<boolean> {
    const sessionId = state.value?.sessionId
    if (!sessionId || isShowingFileInFolder.value)
      return false
    const currentLifecycle = lifecycle
    isShowingFileInFolder.value = true
    try {
      const opened = await options.api.showFileInFolder(sessionId)
      return mounted && lifecycle === currentLifecycle && opened
    }
    catch {
      return false
    }
    finally {
      if (mounted && lifecycle === currentLifecycle)
        isShowingFileInFolder.value = false
    }
  }

  function goBack(): Promise<boolean> {
    return runSessionCommand(sessionId => options.api.goBack(sessionId))
  }

  function goForward(): Promise<boolean> {
    return runSessionCommand(sessionId => options.api.goForward(sessionId))
  }

  function reload(): Promise<boolean> {
    return runSessionCommand(sessionId => options.api.reload(sessionId))
  }

  function stop(): Promise<boolean> {
    return runSessionCommand(sessionId => options.api.stop(sessionId))
  }

  async function takeControl(): Promise<boolean> {
    const sessionId = state.value?.sessionId
    if (!sessionId || state.value?.controller !== 'agent' || isTakingControl.value)
      return false
    const currentLifecycle = lifecycle
    isTakingControl.value = true
    try {
      return await updateSessionState(sessionId, () => options.api.takeControl(sessionId))
    }
    catch {
      return false
    }
    finally {
      if (mounted && lifecycle === currentLifecycle)
        isTakingControl.value = false
    }
  }

  async function runSessionCommand(
    command: (sessionId: string) => Promise<void>,
  ): Promise<boolean> {
    const sessionId = state.value?.sessionId
    if (!mounted || !sessionId)
      return false
    const currentLifecycle = lifecycle
    try {
      await command(sessionId)
      return mounted && lifecycle === currentLifecycle
    }
    catch {
      return false
    }
  }

  async function updateSessionState(sessionId: string, command: () => Promise<DesktopBrowserState>): Promise<boolean> {
    const currentLifecycle = lifecycle
    const request = ++stateRequest
    const version = stateVersion
    const tabId = options.tabId?.value
    const nextState = await command()
    const current = mounted && lifecycle === currentLifecycle && request === stateRequest && state.value?.sessionId === sessionId
    if (nextState.sessionId !== sessionId)
      options.sessionReady(nextState, tabId)
    if (!current)
      return false
    if (version === stateVersion)
      options.updateState(nextState)
    return true
  }

  return {
    captureScreenshot,
    failed: readonly(failed),
    goBack,
    goForward,
    isCapturingScreenshot: readonly(isCapturingScreenshot),
    isSettingZoom: readonly(isSettingZoom),
    isLoading: readonly(isLoading),
    isOpeningExternal: readonly(isOpeningExternal),
    isShowingFileInFolder: readonly(isShowingFileInFolder),
    isSwitchingProfile: readonly(isSwitchingProfile),
    isTakingControl: readonly(isTakingControl),
    navigate,
    openExternal,
    reload,
    setProfileMode,
    setZoomFactor,
    showFileInFolder,
    state: readonly(state),
    stop,
    takeControl,
  }
}

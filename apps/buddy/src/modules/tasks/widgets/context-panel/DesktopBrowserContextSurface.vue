<script setup lang="ts">
import type { DesktopBrowserApi, DesktopBrowserState } from '@buddy-electron/shared/desktopApi'
import type { TaskBrowserContextTab } from '../../model/context-panel/taskContextPanel'
import type { BrowserToolbarBusyAction, BrowserToolbarMenuActionKey } from './browserToolbarMenu'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { DesktopBrowserGuestSurfaceHost } from '@/platform/browser/browserGuestSurface'
import { Pause16Regular } from '@vicons/fluent'
import { useMessage } from 'naive-ui'
import { computed, shallowRef, toRef, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import ResourceSelectionQuoteMenu from '@/shared/ui/selection/ResourceSelectionQuoteMenu.vue'
import { useResourceSelectionQuote } from '@/shared/ui/selection/useResourceSelectionQuote'
import { useSelectionReferences } from '@/shared/ui/selection/workbenchSelectionReferences'
import WorkbenchPanelContent from '@/workbench/browser/WorkbenchPanelContent.vue'
import DesktopBrowserErrorPage from './DesktopBrowserErrorPage.vue'
import DesktopBrowserLoadingBar from './DesktopBrowserLoadingBar.vue'
import DesktopBrowserToolbar from './DesktopBrowserToolbar.vue'
import { useBrowserAddress } from './useBrowserAddress'
import { useBrowserContextSurface } from './useBrowserContextSurface'
import { browserElementPickMenuPosition, useBrowserElementReference } from './useBrowserElementReference'

const props = defineProps<{
  tab: TaskBrowserContextTab | null
  api: DesktopBrowserApi
  guestHost: DesktopBrowserGuestSurfaceHost
  state: DesktopBrowserState | null
  updateState: (state: DesktopBrowserState) => void
  sessionReady: (state: DesktopBrowserState, key?: string) => void
  language: BuddyLocale
  visible: boolean
}>()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const browserTab = toRef(() => props.tab)
const surfaceElement = useTemplateRef<HTMLElement>('surfaceElement')
const browserView = useBrowserContextSurface({
  api: props.api,
  conversationId: computed(() => browserTab.value?.conversationId ?? null),
  tabId: computed(() => browserTab.value?.browserKey),
  enabled: computed(() => Boolean(browserTab.value)),
  visible: toRef(() => props.visible),
  state: toRef(() => props.state),
  updateState: state => props.updateState(state),
  sessionReady: (state, key) => props.sessionReady(state, key),
  guestHost: props.guestHost,
  surfaceElement,
})
const { address, openAddress, updateAddress } = useBrowserAddress(browserView.state, browserView.navigate)
const browserState = browserView.state
const browserFailed = computed(() => browserView.failed.value || browserState.value?.status === 'error')
const selectionReferences = useSelectionReferences()
const browserViewId = computed(() => `browser:${browserTab.value?.id ?? ''}`)
const pickerOwner = computed(() => JSON.stringify([browserTab.value?.scope, browserState.value?.sessionId, browserState.value?.pageId, browserState.value?.documentVersion, browserState.value?.url]))
const selection = useResourceSelectionQuote({
  viewId: () => browserViewId.value,
  ownerKey: () => pickerOwner.value,
  visible: () => props.visible,
  language: () => props.language,
})
const picker = useBrowserElementReference({
  api: props.api,
  state: browserState,
  viewId: browserViewId,
  visible: toRef(() => props.visible),
  feedback(result, title) {
    if (result === 'added')
      message.success(t('desktop.chat.quoteAddedToTarget', { title: title ?? '' }))
    else if (result === 'duplicate')
      message.info(t('desktop.chat.quoteDuplicate'))
    else
      message.warning(t(result === 'limit' ? 'desktop.chat.quoteLimit' : 'desktop.context.browserPickUnavailable'))
  },
  choose(request, anchor) {
    const rect = surfaceElement.value?.getBoundingClientRect()
    if (!rect?.width || !rect.height) {
      message.warning(t('desktop.context.browserPickUnavailable'))
      return
    }
    const position = browserElementPickMenuPosition(anchor, rect)
    selection.openRequest(request, position.x, position.y)
  },
})
watch(() => selectionReferences?.captureScope(browserViewId.value)?.sourceIdentity, () => picker.cancel(), { flush: 'sync' })
const browserBlank = computed(() => browserState.value?.url === 'about:blank' && browserState.value.status === 'idle' && !browserView.isLoading.value)
const controlAnnouncement = shallowRef('')
watch(() => browserState.value?.controller, (controller, previous) => {
  if (controller === 'agent')
    controlAnnouncement.value = t('desktop.context.browserAgentControlling')
  else if (previous === 'agent')
    controlAnnouncement.value = t('desktop.context.browserAgentPaused')
})
const busyAction = computed<BrowserToolbarBusyAction | null>(() => browserView.isSwitchingProfile.value
  ? 'profile'
  : browserView.isCapturingScreenshot.value
    ? 'screenshot'
    : browserView.isOpeningExternal.value
      ? 'external'
      : browserView.isShowingFileInFolder.value ? 'folder' : browserView.isSettingZoom.value ? 'zoom' : null)
async function captureScreenshot() {
  const result = await browserView.captureScreenshot()
  if (result === 'saved' || result === 'copied')
    message.success(t(result === 'saved' ? 'desktop.browser.screenshotSaved' : 'desktop.browser.screenshotCopied'))
  else if (result === 'failed')
    message.error(t('desktop.browser.screenshotFailed'))
}
async function setZoom(factor: number | null) {
  if (!await browserView.setZoomFactor(factor))
    message.error(t('desktop.browser.zoomFailed'))
}
function browserMenu(action: BrowserToolbarMenuActionKey) {
  if (action === 'capture-screenshot')
    void captureScreenshot()
  else if (action === 'enter-incognito')
    void browserView.setProfileMode('incognito')
  else if (action === 'exit-incognito')
    void browserView.setProfileMode('default')
  else if (action === 'open-external')
    void browserView.openExternal()
  else if (action === 'show-file-in-folder')
    void browserView.showFileInFolder()
}
</script>

<template>
  <WorkbenchPanelContent v-if="browserTab">
    <template #toolbar>
      <div class="relative min-w-0 flex-1">
        <DesktopBrowserToolbar :picking="picker.picking.value" :pick-label="t('desktop.context.browserPickElement')" :pick-disabled="!selectionReferences || browserState?.status !== 'ready' || browserState?.controller === 'agent' || busyAction !== null" :address="address" :busy-action="busyAction" :language="language" :state="browserState" @back="browserView.goBack" @forward="browserView.goForward" @navigate="openAddress" @reload="browserView.reload" @stop="browserView.stop" @update:address="updateAddress" @menu="browserMenu" @zoom="setZoom" @pick="picker.toggle" />
        <DesktopBrowserLoadingBar :key="browserTab.id" :loading="browserView.isLoading.value" :failed="browserFailed" :language="language" />
      </div>
    </template>
    <ResourceSelectionQuoteMenu :selection="selection" :language="language" />
    <section class="desktop-browser-context-surface flex min-w-0 min-h-0 flex-1 flex-col bg-surface" data-testid="browser-context-surface">
      <div
        v-if="browserState?.controller === 'agent'"
        class="relative z-2 flex min-w-0 min-h-[2.375rem] flex-none items-center justify-between gap-3 border-b-1 border-b-solid border-b-accent-border bg-accent-subtle text-accent-on-surface pt-1 pr-2 pb-1 pl-3"
        data-testid="browser-agent-control"
      >
        <span class="flex min-w-0 items-center gap-2 text-[0.75rem] font-600 whitespace-nowrap">
          <span class="w-2 h-2 flex-none rounded-full bg-accent" aria-hidden="true" />
          {{ t('desktop.context.browserAgentControlling') }}
        </span>
        <button
          class="desktop-browser-context-surface__take-control flex min-h-[1.875rem] flex-none items-center gap-[0.375rem] border-0 rounded-[0.375rem] bg-accent text-on-accent cursor-pointer text-[0.75rem] font-600 py-1 px-[0.625rem] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[2px]"
          data-testid="browser-take-control"
          type="button"
          :aria-label="t(browserView.isTakingControl.value
            ? 'desktop.context.browserTakingControl'
            : 'desktop.context.browserTakeControl')"
          :aria-busy="browserView.isTakingControl.value"
          :disabled="browserView.isTakingControl.value"
          @click="browserView.takeControl"
        >
          <DesktopIcon aria-hidden="true" :component="Pause16Regular" />
          <span>
            {{ t(browserView.isTakingControl.value
              ? 'desktop.context.browserTakingControl'
              : 'desktop.context.browserTakeControl') }}
          </span>
        </button>
      </div>
      <span
        class="desktop-browser-context-surface__announcement absolute w-[1px] h-[1px] overflow-hidden whitespace-nowrap"
        data-testid="browser-control-announcement"
        aria-atomic="true"
        aria-live="polite"
        role="status"
      >
        {{ controlAnnouncement }}
      </span>
      <div
        class="relative min-w-0 min-h-0 flex-1 bg-surface"
        data-testid="browser-guest-surface"
        role="group"
        :aria-label="t('desktop.context.browserViewport')"
        :aria-busy="browserView.isLoading.value"
      >
        <DesktopBrowserErrorPage v-if="browserFailed" :state="browserState" :initialization-failed="browserView.failed.value" :language="language" @retry="browserView.retry" />
        <div v-else ref="surfaceElement" class="absolute inset-0" />
        <div v-if="browserBlank && !browserFailed" class="desktop-browser-context-surface__empty absolute z-2 inset-0 grid place-items-center bg-surface text-muted p-[24px] pointer-events-none text-[13px] text-center">
          <p>{{ t('desktop.context.browserStartBrowsing') }}</p>
        </div>
      </div>
    </section>
  </WorkbenchPanelContent>
</template>

<style scoped lang="scss">
.desktop-browser-context-surface__take-control:not(:disabled):hover {
  background: var(--buddy-accent-solid-hover);
}

.desktop-browser-context-surface__take-control:not(:disabled):active {
  background: var(--buddy-accent-solid-pressed);
}

.desktop-browser-context-surface__take-control:disabled {
  cursor: wait;
  opacity: 0.72;
}

.desktop-browser-context-surface__announcement {
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
}

.desktop-browser-context-surface__empty p {
  margin: 0;
}
</style>

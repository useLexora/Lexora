<script setup lang="ts">
import type {
  DesktopBrowserState,
} from '@buddy-electron/shared/desktopApi'

import type { DropdownOption } from 'naive-ui'
import type { Component } from 'vue'
import type {
  BrowserToolbarBusyAction,
  BrowserToolbarMenuActionKey,
} from './browserToolbarMenu'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import {
  ArrowClockwise16Regular,
  ArrowLeft16Regular,
  ArrowRight16Regular,
  Camera20Regular,
  FolderOpen20Regular,
  Globe16Regular,
  LockClosed16Regular,
  MoreHorizontal20Regular,
  Open20Regular,
  Stop16Regular,
  TabInPrivate20Regular,
  Warning16Regular,
} from '@vicons/fluent'
import { NDropdown, NTooltip } from 'naive-ui'
import { computed, h, useId } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { getBrowserToolbarMenuActions } from './browserToolbarMenu'
import DesktopBrowserZoomControls from './DesktopBrowserZoomControls.vue'

const props = defineProps<{
  busyAction: BrowserToolbarBusyAction | null
  language: BuddyLocale
  state: DesktopBrowserState | null
}>()
const emit = defineEmits<{
  back: []
  forward: []
  menu: [action: BrowserToolbarMenuActionKey]
  navigate: []
  reload: []
  stop: []
  zoom: [factor: number | null]
}>()
const address = defineModel<string>('address', { required: true })
const addressId = useId()
const { t } = useBuddyI18n(() => props.language)

const securityIcon = computed(() => {
  const kind = props.state?.security.kind ?? 'blank'
  if (kind === 'certificate-error' || kind === 'insecure')
    return Warning16Regular
  if (kind === 'secure')
    return LockClosed16Regular
  return Globe16Regular
})
const securityLabel = computed(() => {
  const security = props.state?.security
  if (!security || security.kind === 'blank')
    return t('desktop.context.browserSecurityBlank')
  if (security.kind === 'certificate-error')
    return t('desktop.context.browserSecurityCertificateError')
  if (security.kind === 'insecure')
    return t('desktop.context.browserSecurityInsecure')
  if (security.kind === 'local') {
    return t(security.origin.startsWith('http://')
      ? 'desktop.context.browserSecurityLocalHttp'
      : 'desktop.context.browserSecurityLocal')
  }
  return t('desktop.context.browserSecuritySecure')
})
const isLoading = computed(() => props.state?.status === 'loading')
const isIncognito = computed(() => props.state?.profileMode === 'incognito')
const menuIconByAction: Record<BrowserToolbarMenuActionKey, Component> = {
  'capture-screenshot': Camera20Regular,
  'enter-incognito': TabInPrivate20Regular,
  'exit-incognito': TabInPrivate20Regular,
  'open-external': Open20Regular,
  'show-file-in-folder': FolderOpen20Regular,
}
const menuOptions = computed<DropdownOption[]>(() => {
  const actions = getBrowserToolbarMenuActions({
    busyAction: props.busyAction,
    controller: props.state?.controller ?? 'human',
    profileMode: props.state?.profileMode ?? 'default',
    url: props.state?.url ?? 'about:blank',
  })
  return [{
    key: 'browser-zoom',
    type: 'render',
    render: () => h(DesktopBrowserZoomControls, {
      language: props.language,
      zoomFactor: props.state?.zoomFactor ?? 1,
      disabled: !props.state || props.busyAction !== null,
      onZoom: factor => emit('zoom', factor),
    }),
  }, { key: 'browser-zoom-divider', type: 'divider' }, ...actions.flatMap((action, index): DropdownOption[] => [
    ...(index === 1
      ? [{ key: 'browser-profile-divider', type: 'divider' as const }]
      : []),
    {
      disabled: action.disabled,
      icon: () => h(DesktopIcon, { component: menuIconByAction[action.key] }),
      key: action.key,
      label: t(action.labelKey),
    },
  ])]
})

function handleMenuAction(value: string | number): void {
  const action = getBrowserToolbarMenuActions({
    busyAction: props.busyAction,
    controller: props.state?.controller ?? 'human',
    profileMode: props.state?.profileMode ?? 'default',
    url: props.state?.url ?? 'about:blank',
  }).find(action => action.key === value)
  if (action && !action.disabled)
    emit('menu', action.key)
}

function toggleLoading(): void {
  if (isLoading.value)
    emit('stop')
  else
    emit('reload')
}

function selectAddress(event: FocusEvent): void {
  if (event.currentTarget instanceof HTMLInputElement)
    event.currentTarget.select()
}
</script>

<template>
  <form
    class="desktop-browser-toolbar"
    :class="{ 'desktop-browser-toolbar--incognito': isIncognito }"
    :aria-label="t('desktop.context.browserToolbar')"
    novalidate
    @submit.prevent="emit('navigate')"
  >
    <NTooltip placement="bottom">
      <template #trigger>
        <button
          class="desktop-browser-toolbar__action"
          data-testid="browser-back"
          type="button"
          :aria-label="t('desktop.context.browserBack')"
          :disabled="!state?.canGoBack"
          @click="emit('back')"
        >
          <DesktopIcon aria-hidden="true" :component="ArrowLeft16Regular" />
        </button>
      </template>
      <span role="tooltip">{{ t('desktop.context.browserBack') }}</span>
    </NTooltip>
    <NTooltip placement="bottom">
      <template #trigger>
        <button
          class="desktop-browser-toolbar__action"
          data-testid="browser-forward"
          type="button"
          :aria-label="t('desktop.context.browserForward')"
          :disabled="!state?.canGoForward"
          @click="emit('forward')"
        >
          <DesktopIcon aria-hidden="true" :component="ArrowRight16Regular" />
        </button>
      </template>
      <span role="tooltip">{{ t('desktop.context.browserForward') }}</span>
    </NTooltip>
    <label class="desktop-browser-toolbar__label" :for="addressId">
      {{ t('desktop.context.browserAddressLabel') }}
    </label>
    <div
      class="desktop-browser-toolbar__address-shell"
      :data-security-kind="state?.security.kind ?? 'blank'"
    >
      <NTooltip placement="bottom">
        <template #trigger>
          <span
            class="desktop-browser-toolbar__security"
            data-testid="browser-security"
          >
            <DesktopIcon aria-hidden="true" :component="securityIcon" />
          </span>
        </template>
        <span role="tooltip">{{ securityLabel }}</span>
      </NTooltip>
      <input
        :id="addressId"
        v-model="address"
        :disabled="!state"
        class="desktop-browser-toolbar__address"
        data-testid="browser-address"
        autocomplete="off"
        inputmode="url"
        name="browser-address"
        :placeholder="t('desktop.context.browserAddressPlaceholder')"
        spellcheck="false"
        type="text"
        @focus="selectAddress"
      >
    </div>
    <NTooltip v-if="isIncognito" placement="bottom">
      <template #trigger>
        <span
          class="desktop-browser-toolbar__incognito"
          data-testid="browser-incognito-indicator"
        >
          <DesktopIcon aria-hidden="true" :component="TabInPrivate20Regular" />
          <span>{{ t('desktop.context.browserIncognito') }}</span>
        </span>
      </template>
      <span role="tooltip">{{ t('desktop.context.browserIncognitoHint') }}</span>
    </NTooltip>
    <NTooltip placement="bottom">
      <template #trigger>
        <button
          class="desktop-browser-toolbar__action"
          data-testid="browser-reload-stop"
          type="button"
          :aria-label="t(isLoading ? 'desktop.context.browserStop' : 'desktop.context.browserReload')"
          :disabled="!state || (!isLoading && state.url === 'about:blank')"
          @click="toggleLoading"
        >
          <DesktopIcon
            aria-hidden="true"
            :component="isLoading ? Stop16Regular : ArrowClockwise16Regular"
          />
        </button>
      </template>
      <span role="tooltip">
        {{ t(isLoading ? 'desktop.context.browserStop' : 'desktop.context.browserReload') }}
      </span>
    </NTooltip>
    <NDropdown
      trigger="click"
      placement="bottom-end"
      size="small"
      :options="menuOptions"
      @select="handleMenuAction"
    >
      <button
        class="desktop-browser-toolbar__action"
        data-testid="browser-more"
        type="button"
        :aria-label="t('desktop.context.browserMoreActions')"
        aria-haspopup="menu"
      >
        <DesktopIcon aria-hidden="true" :component="MoreHorizontal20Regular" />
      </button>
    </NDropdown>
  </form>
</template>

<style scoped>
.desktop-browser-toolbar {
  position: relative;
  z-index: 2;
  display: flex;
  min-width: 0;
  width: 100%;
  height: 3.25rem;
  flex: none;
  align-items: center;
  gap: 0.375rem;
  background: var(--buddy-surface-base);
  padding: 0.5rem;
}

.desktop-browser-toolbar--incognito {
  background: color-mix(in srgb, var(--buddy-surface-muted) 82%, #4d4267 18%);
}

.desktop-browser-toolbar__label {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}

.desktop-browser-toolbar__action {
  display: grid;
  width: 2.25rem;
  height: 2.25rem;
  flex: none;
  place-items: center;
  border: 0;
  border-radius: var(--buddy-icon-button-radius);
  background: transparent;
  color: var(--buddy-text-secondary);
  cursor: pointer;
}

.desktop-browser-toolbar__action:not(:disabled):hover {
  background: var(--buddy-state-hover);
  color: var(--buddy-text-strong);
}

.desktop-browser-toolbar__action:focus-visible,
.desktop-browser-toolbar__address-shell:focus-within {
  outline: 2px solid var(--buddy-focus-ring);
  outline-offset: -2px;
}

.desktop-browser-toolbar__action:disabled {
  cursor: default;
  opacity: 0.4;
}

.desktop-browser-toolbar__address-shell {
  display: flex;
  min-width: 0;
  height: 2.25rem;
  flex: 1;
  align-items: center;
  border: 1px solid transparent;
  border-radius: 0.625rem;
  background: var(--buddy-surface-muted);
}

.desktop-browser-toolbar__address-shell:hover {
  border-color: var(--buddy-border-subtle);
}

.desktop-browser-toolbar__address-shell:focus-within {
  border-color: transparent;
  background: var(--buddy-surface-base);
}

.desktop-browser-toolbar__security {
  display: grid;
  width: 2rem;
  height: 100%;
  flex: none;
  place-items: center;
  color: var(--buddy-text-muted);
}

.desktop-browser-toolbar__address-shell[data-security-kind='certificate-error']
  .desktop-browser-toolbar__security,
.desktop-browser-toolbar__address-shell[data-security-kind='insecure']
  .desktop-browser-toolbar__security {
  color: var(--buddy-status-danger-text);
}

.desktop-browser-toolbar__address {
  min-width: 0;
  height: 100%;
  flex: 1;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--buddy-text-strong);
  font: inherit;
  font-size: 0.78rem;
  padding: 0 0.625rem 0 0;
}

.desktop-browser-toolbar__incognito {
  display: flex;
  height: 2rem;
  flex: none;
  align-items: center;
  gap: 0.3rem;
  border-radius: 0.375rem;
  color: var(--buddy-text-primary);
  font-size: 0.72rem;
  font-weight: 600;
  padding: 0 0.375rem;
  white-space: nowrap;
}

@media (max-width: 1180px) {
  .desktop-browser-toolbar__incognito span {
    display: none;
  }
}
</style>

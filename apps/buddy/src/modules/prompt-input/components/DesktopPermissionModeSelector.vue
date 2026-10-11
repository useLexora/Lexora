<script setup lang="ts">
import type { BuddyPermissionMode } from '@buddy-shared/permissions/permissionMode'

import type { BuddySessionMode } from '@buddy-shared/permissions/sessionMode'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import {
  ArrowClockwise20Regular,
  HandLeft20Regular,
  LockClosed20Regular,
  LockOpen20Regular,
  ShieldTask20Regular,
  Warning20Regular,
} from '@vicons/fluent'
import { NButton, NModal, NPopover, NTooltip } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopFullAccessConfirmationDialog from '@/modules/prompt-input/components/DesktopFullAccessConfirmationDialog.vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useShellSandboxStatus } from '../state/useShellSandboxStatus'

const props = defineProps<{
  canUpdate: boolean
  isUpdating: boolean
  language: BuddyLocale
  permissionMode: BuddyPermissionMode
  sessionMode?: BuddySessionMode
}>()

const emit = defineEmits<{
  updatePermissionMode: [value: BuddyPermissionMode]
}>()

const permissionOptions = [
  {
    description: 'desktop.chat.permissionModeReadOnlyDescription',
    sandboxDescription: 'desktop.chat.permissionModeReadOnlySandboxDescription',
    icon: LockClosed20Regular,
    label: 'desktop.chat.executionProfileReadOnly',
    value: 'read_only',
  },
  {
    description: 'desktop.chat.permissionModeManualDescription',
    sandboxDescription: 'desktop.chat.permissionModeManualSandboxDescription',
    icon: HandLeft20Regular,
    label: 'desktop.chat.permissionModeManual',
    value: 'manual_approval',
  },
  {
    description: 'desktop.chat.permissionModePolicyDescription',
    sandboxDescription: 'desktop.chat.permissionModePolicySandboxDescription',
    icon: ShieldTask20Regular,
    label: 'desktop.chat.permissionModePolicy',
    value: 'policy_approval',
  },
  {
    description: 'desktop.chat.permissionModeFullDescription',
    sandboxDescription: 'desktop.chat.permissionModeFullDescription',
    icon: LockOpen20Regular,
    label: 'desktop.chat.executionProfileFull',
    value: 'full_access',
  },
] as const

const { t } = useBuddyI18n(() => props.language)
const fullAccessConfirmationText = computed(() => ({
  acknowledgement: t('desktop.chat.executionProfileFullConfirmAcknowledgement'),
  cancelLabel: t('common.cancel'),
  confirmLabel: t('desktop.chat.executionProfileAllowFull'),
  description: t('desktop.chat.executionProfileFullConfirmDescription'),
  title: t('desktop.chat.executionProfileFullConfirmTitle'),
}))
const isBackground = computed(() => props.sessionMode === 'automation_background')
const availableOptions = computed(() => permissionOptions.filter(
  option => !isBackground.value || option.value !== 'manual_approval',
))
const confirmationOpen = shallowRef(false)
const popoverOpen = shallowRef(false)
const setupOpen = shallowRef(false)
const { availability, isChecking, isSettingUp, setupResult, recheck, setup } = useShellSandboxStatus(popoverOpen)
const sandboxStatus = computed(() => availability.value.status)
const boundaryWarning = computed(() => props.permissionMode !== 'full_access' && !availability.value.ready && !availability.value.checking)
const selected = computed(() => permissionOptions.find(
  option => option.value === props.permissionMode,
) ?? permissionOptions[2])
const isFullAccess = computed(() => props.permissionMode === 'full_access')

function selectMode(value: BuddyPermissionMode) {
  if (value === props.permissionMode) {
    popoverOpen.value = false
    return
  }
  if (value === 'full_access') {
    popoverOpen.value = false
    confirmationOpen.value = true
    return
  }
  emit('updatePermissionMode', value)
  popoverOpen.value = false
}

function confirmFullAccess() {
  emit('updatePermissionMode', 'full_access')
}

async function confirmSetup() {
  const result = await setup()
  if (result === 'ready' || result === 'incompatible') {
    setupOpen.value = false
    popoverOpen.value = true
  }
}
</script>

<template>
  <NPopover
    placement="top-start"
    trigger="click"
    :show="popoverOpen"
    :show-arrow="false"
    @update:show="popoverOpen = $event"
  >
    <template #trigger>
      <NButton
        class="desktop-permission-mode-selector__trigger"
        :class="{ 'is-full-access': isFullAccess, 'has-warning': boundaryWarning }"
        quaternary
        size="small"
        :aria-label="t('desktop.chat.executionProfileOpen')"
        :aria-description="boundaryWarning ? t(`desktop.chat.shellSandboxStatus.${sandboxStatus}`) : undefined"
        :aria-expanded="popoverOpen"
      >
        <template #icon>
          <DesktopIcon :component="selected.icon" />
        </template>
        <span class="desktop-permission-mode-selector__trigger-label">
          {{ t(selected.label) }}
        </span>
        <NTooltip v-if="boundaryWarning" placement="top" :disabled="popoverOpen">
          <template #trigger>
            <span
              class="desktop-permission-mode-selector__warning absolute top-[-0.1rem] right-[-0.1rem] z-1 inline-flex w-[0.875rem] h-[0.875rem] items-center justify-center text-warning"
              role="img"
              :aria-label="t(`desktop.chat.shellSandboxStatus.${sandboxStatus}`)"
            >
              <DesktopIcon :component="Warning20Regular" :size="16" aria-hidden="true" />
            </span>
          </template>
          <div class="desktop-permission-mode-selector__warning-tooltip grid max-w-[min(18rem,_calc(100vw_-_2rem))] gap-1">
            <strong>{{ t(`desktop.chat.shellSandboxStatus.${sandboxStatus}`) }}</strong>
            <span>{{ t(`desktop.chat.shellSandboxHint.${sandboxStatus}`) }}</span>
          </div>
        </NTooltip>
      </NButton>
    </template>

    <section class="w-[min(18rem,_calc(100vw_-_1rem))]">
      <header class="pt-[0.1rem] pr-1 pb-[0.45rem] pl-1 text-muted text-[0.7rem] leading-[1.4]">
        {{ t('desktop.chat.permissionModeTitle') }}
      </header>
      <div class="grid gap-[0.15rem]" role="menu">
        <button
          v-for="option in availableOptions"
          :key="option.value"
          class="desktop-permission-mode-selector__option grid w-full grid-cols-[1.1rem_minmax(0,_1fr)] items-center border-0 rounded-menu-item py-[0.36rem] px-[0.35rem] bg-transparent text-fg gap-x-2 cursor-pointer text-left ui-focus-ring disabled:cursor-not-allowed disabled:opacity-55"
          :class="{
            'is-danger': option.value === 'full_access',
            'is-selected': option.value === permissionMode,
          }"
          :disabled="!canUpdate || isUpdating"
          role="menuitemradio"
          :aria-checked="option.value === permissionMode"
          type="button"
          @click="selectMode(option.value)"
        >
          <DesktopIcon
            class="desktop-permission-mode-selector__option-icon"
            :component="option.icon"
          />
          <span class="desktop-permission-mode-selector__option-copy grid min-w-0 gap-[0.05rem]">
            <strong>{{ t(option.label) }}</strong>
            <small>{{ t(availability.isolated ? option.sandboxDescription : option.description) }}</small>
          </span>
        </button>
      </div>
      <small v-if="!canUpdate && !isUpdating" class="block border-t-1 border-t-solid border-t-border mt-[0.3rem] pt-[0.4rem] pr-1 pb-[0.05rem] pl-1 text-muted text-[0.68rem]">
        {{ t('desktop.chat.executionProfileRunLocked') }}
      </small>
      <footer v-if="boundaryWarning" class="grid gap-1 mt-[0.45rem] border-t-1 border-t-solid border-t-border pt-[0.55rem] pr-1 pb-[0.1rem] pl-1 text-warning text-[0.7rem] leading-[1.5]" role="status">
        <strong>{{ t(`desktop.chat.shellSandboxStatus.${sandboxStatus}`) }}</strong>
        <span>{{ t(`desktop.chat.shellSandboxHint.${sandboxStatus}`) }}</span>
        <NButton v-if="availability.action" size="small" :disabled="!canUpdate || isSettingUp" @click="popoverOpen = false; setupOpen = true">
          {{ t(availability.action === 'repair' ? 'desktop.chat.shellSandboxSetup.repair' : 'desktop.chat.shellSandboxSetup.enable') }}
        </NButton>
        <NButton v-else-if="sandboxStatus === 'incompatible'" size="small" :loading="isChecking" @click="recheck">
          <template #icon>
            <DesktopIcon :component="ArrowClockwise20Regular" />
          </template>
          {{ t('desktop.chat.shellSandboxSetup.recheck') }}
        </NButton>
      </footer>
    </section>
  </NPopover>

  <DesktopFullAccessConfirmationDialog
    v-model:show="confirmationOpen"
    :text="fullAccessConfirmationText"
    @confirm="confirmFullAccess"
  />

  <NModal
    :show="setupOpen"
    preset="dialog"
    type="info"
    :title="t('desktop.chat.shellSandboxSetup.title')"
    :closable="!isSettingUp"
    :mask-closable="!isSettingUp"
    :close-on-esc="!isSettingUp"
    :style="{ width: 'min(28rem, calc(100vw - 2rem))' }"
    @update:show="setupOpen = $event"
  >
    <p>{{ t('desktop.chat.shellSandboxSetup.description') }}</p>
    <p v-if="setupResult && setupResult !== 'ready'" role="status">
      {{ t(`desktop.chat.shellSandboxSetup.${setupResult}`) }}
    </p>
    <template #action>
      <NButton :disabled="isSettingUp" @click="setupOpen = false">
        {{ t('common.cancel') }}
      </NButton>
      <NButton type="primary" :loading="isSettingUp" @click="confirmSetup">
        {{ t(isSettingUp ? 'desktop.chat.shellSandboxSetup.waiting' : 'desktop.chat.shellSandboxSetup.confirm') }}
      </NButton>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.desktop-permission-mode-selector__trigger {
  position: relative;
  min-width: 0;
  height: var(--buddy-composer-control-height);
  border-radius: var(--buddy-composer-control-radius);
  background-color: transparent;
  color: var(--buddy-text-secondary);

  &.n-button:not(.n-button--disabled):not(.is-full-access):hover,
  &.n-button:not(.n-button--disabled):not(.is-full-access):focus-visible,
  &.n-button:not(.n-button--disabled):not(.is-full-access)[aria-expanded='true'] {
    background-color: var(--buddy-accent-surface-subtle);
    color: var(--buddy-text-strong);
  }

  &:focus-visible {
    outline: 2px solid var(--buddy-focus-ring);
    outline-offset: -2px;
  }

  &.is-full-access {
    background-color: var(--buddy-status-danger-surface);
    color: var(--buddy-status-danger-text);
  }
}

.desktop-permission-mode-selector__warning-tooltip {
  white-space: normal;
}

.desktop-permission-mode-selector__option {
  &:hover:not(:disabled),
  &:focus-visible:not(:disabled) {
    background: var(--buddy-accent-surface-subtle);
  }

  &.is-danger {
    color: var(--buddy-status-danger-text);
  }

  &.is-selected:not(.is-danger) {
    background: var(--buddy-accent-surface);
    color: var(--buddy-text-strong);
  }

  &.is-selected.is-danger {
    background: var(--buddy-status-danger-surface);
  }
}

.desktop-permission-mode-selector__option-icon {
  font-size: 1.05rem;
}

.desktop-permission-mode-selector__option-copy {
  strong {
    font-size: 0.8rem;
    font-weight: 580;
    line-height: 1.35;
  }

  small {
    color: var(--buddy-text-muted);
    font-size: 0.67rem;
    line-height: 1.35;
  }
}

.desktop-permission-mode-selector__option.is-danger small {
  color: var(--buddy-status-danger-text);
  opacity: 0.82;
}
</style>

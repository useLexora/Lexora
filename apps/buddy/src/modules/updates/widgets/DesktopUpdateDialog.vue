<script setup lang="ts">
import type { DesktopUpdateCheckResult, DesktopUpdateDeliveryState } from '@buddy-electron/shared/desktopUpdates'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { compareDesktopVersions } from '@buddy-electron/shared/desktopUpdates'
import { ArrowDownload20Regular, ArrowUpRight20Regular, CheckmarkCircle20Regular, ChevronDown16Regular, History20Regular, MoreHorizontal20Regular } from '@vicons/fluent'
import { NButton, NDropdown, NModal, NScrollbar, NTooltip } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopMarkdownContent from '@/shared/ui/markdown/DesktopMarkdownContent.vue'
import DesktopUpdateDeliveryActions from './DesktopUpdateDeliveryActions.vue'
import DesktopUpdateDeliveryStatus from './DesktopUpdateDeliveryStatus.vue'

const props = defineProps<{
  delivery?: DesktopUpdateDeliveryState
  language: BuddyLocale
  result: DesktopUpdateCheckResult | null
  show: boolean
  pending: boolean
  manualInstallation?: boolean
  ignored?: boolean
  checkFailed?: boolean
  reminderDeferredUntil?: number | null
  latestVersion?: string
  writeClipboardText: (text: string) => Promise<void>
}>()
const emit = defineEmits<{
  'openRelease': [url: string]
  'ignore': [version: string]
  'restore': [version: string]
  'snooze': [version: string, delay: '30-minutes' | 'tomorrow']
  'cancelSnooze': [version: string]
  'showLatest': []
  'check': []
  'download': []
  'cancelDownload': []
  'install': []
  'showInstallation': []
  'openPackage': []
  'openDownloadDirectory': []
  'update:show': [show: boolean]
}>()
const { t } = useBuddyI18n(() => props.language)
const installing = computed(() => props.delivery?.status === 'installing')
const installationFailed = computed(() => props.delivery?.reason === 'installer-unavailable' && props.delivery.version === props.result?.latestVersion)
const updateAvailable = computed(() => props.result?.status === 'update_available' || installationFailed.value)
const outdated = computed(() => !installing.value && !!props.result && !!props.latestVersion && props.latestVersion !== props.result.latestVersion)
const newer = computed(() => !!props.result && !!props.latestVersion && compareDesktopVersions(props.latestVersion, props.result.latestVersion) > 0)
const laterOptions = computed(() => [
  { key: 'close', label: t('desktop.update.dismiss') },
  { key: '30-minutes', label: t('desktop.update.remindIn30Minutes') },
  { key: 'tomorrow', label: t('desktop.update.remindTomorrow') },
  ...(props.reminderDeferredUntil ? [{ key: 'cancel-snooze', label: t('desktop.update.cancelSnooze') }] : []),
])
const reminderDescription = computed(() => props.reminderDeferredUntil ? t('desktop.update.reminderScheduled', { time: new Intl.DateTimeFormat(props.language, { dateStyle: 'medium', timeStyle: 'short' }).format(props.reminderDeferredUntil) }) : '')
const moreOptions = computed(() => [{ key: 'directory', label: t('desktop.update.openDownloadDirectory') }])

function selectLater(key: string) {
  if (key === 'close')
    emit('update:show', false)
  else if (props.result && key === 'cancel-snooze')
    emit('cancelSnooze', props.result.latestVersion)
  else if (props.result && (key === '30-minutes' || key === 'tomorrow'))
    emit('snooze', props.result.latestVersion, key)
}

function updateVersionReminder() {
  if (!props.result)
    return
  if (props.ignored)
    emit('restore', props.result.latestVersion)
  else
    emit('ignore', props.result.latestVersion)
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    class="desktop-update-dialog"
    :style="{ width: 'min(42rem, calc(100vw - 2rem))', maxHeight: 'calc(100vh - 2rem)' }"
    content-class="min-h-0 flex flex-col"
    :title="t('desktop.update.title')"
    :auto-focus="false"
    :closable="!installing"
    :mask-closable="!installing"
    :close-on-esc="!installing"
    @update:show="emit('update:show', $event)"
  >
    <template v-if="result">
      <!-- 发现新版本视图 -->
      <template v-if="updateAvailable">
        <header class="flex items-center gap-[14px] pt-[2px] pr-0 pb-[14px] pl-0 flex-none">
          <div class="desktop-update-dialog__icon-wrap is-update flex items-center justify-center flex-none w-[44px] h-[44px] rounded-[12px]">
            <DesktopIcon :component="ArrowDownload20Regular" :size="22" aria-hidden="true" />
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-[8px]">
              <h2 class="m-0 text-strong text-[16px] font-600 leading-[1.35]">
                Lexora Buddy {{ result.latestVersion }}
              </h2>
              <span class="inline-flex items-center py-[2px] px-[7px] rounded-[4px] bg-accent-surface text-accent-text text-[11px] font-600 leading-[1.3]">{{ t(installationFailed ? 'desktop.update.installationIncomplete' : ignored ? 'desktop.update.skippedTag' : 'desktop.update.newTag') }}</span>
            </div>
            <p class="mt-[3px] mr-0 mb-0 ml-0 text-muted text-[12px] leading-[1.5]">
              {{ t('desktop.update.currentVersion') }} v{{ result.currentVersion }}
            </p>
          </div>
        </header>

        <section class="rounded-[8px] border border-solid border-border bg-raised py-[12px] px-[14px] min-h-0 flex flex-col">
          <div class="flex items-center justify-between gap-[12px] mb-[8px] flex-none">
            <h3 class="desktop-update-dialog__card-title m-0 text-strong text-[12px] font-600">
              {{ t('desktop.update.releaseNotes') }}
            </h3>
            <div class="flex items-center gap-2">
              <NButton
                text
                type="primary"
                size="tiny"
                class="desktop-update-dialog__release-link"
                :disabled="pending"
                @click="emit('openRelease', result.releaseUrl)"
              >
                <template #icon>
                  <DesktopIcon :component="ArrowUpRight20Regular" :size="14" />
                </template>
                {{ t('desktop.update.openRelease') }}
              </NButton>
              <NDropdown v-if="delivery?.version === result.latestVersion && delivery.mode !== 'release'" :menu-props="() => ({ role: 'menu' })" :node-props="option => ({ 'role': 'menuitem', 'aria-disabled': option.disabled ? 'true' : 'false' })" trigger="click" :options="moreOptions" @select="emit('openDownloadDirectory')">
                <NTooltip>
                  <template #trigger>
                    <NButton class="buddy-icon-button" quaternary size="tiny" :disabled="pending || installing" :aria-label="t('desktop.update.moreActions')">
                      <template #icon>
                        <DesktopIcon :component="MoreHorizontal20Regular" :size="18" />
                      </template>
                    </NButton>
                  </template>
                  {{ t('desktop.update.moreActions') }}
                </NTooltip>
              </NDropdown>
            </div>
          </div>

          <NScrollbar
            v-if="result.releaseNotes.trim()"
            :key="result.latestVersion"
            class="min-h-0"
            style="max-height: min(50vh, 30rem)"
          >
            <section
              class="desktop-update-dialog__notes text-fg pr-[12px] [overflow-wrap:anywhere]"
              :aria-label="t('desktop.update.releaseNotes')"
              tabindex="0"
            >
              <DesktopMarkdownContent
                :content="result.releaseNotes"
                :allow-images="false"
                :language="language"
                :write-clipboard-text="writeClipboardText"
                code-overflow="scroll"
              />
            </section>
          </NScrollbar>
          <p v-else class="m-0 text-muted text-[12px] leading-[1.6]">
            {{ t('desktop.update.notesUnavailable') }}
          </p>
        </section>
      </template>

      <!-- 已是最新版本视图 -->
      <template v-else>
        <div class="flex flex-col items-center justify-center text-center pt-[16px] pr-0 pb-[12px] pl-0">
          <div class="desktop-update-dialog__icon-wrap flex items-center justify-center flex-none w-[44px] h-[44px] rounded-[12px]" :class="checkFailed ? 'bg-subtle text-muted' : 'is-latest'">
            <DesktopIcon :component="checkFailed ? History20Regular : CheckmarkCircle20Regular" :size="24" aria-hidden="true" />
          </div>
          <h2 class="mt-[12px] mr-0 mb-[4px] ml-0 text-strong text-[16px] font-600 leading-[1.35]">
            {{ t(checkFailed ? 'desktop.update.cachedResult' : 'desktop.update.latest') }}
          </h2>
          <p class="m-0 text-muted text-[13px] leading-[1.5]">
            {{ t(checkFailed ? 'desktop.update.cachedResultDescription' : 'desktop.update.latestDescription') }} (v{{ result.currentVersion }})
          </p>
        </div>
      </template>
    </template>

    <template #footer>
      <div class="grid gap-[1rem]">
        <p v-if="outdated" class="m-0 text-muted text-[12px] leading-[1.5]" role="status">
          {{ t(newer ? 'desktop.update.newerVersion' : 'desktop.update.changedResult', { version: latestVersion ?? '' }) }}
        </p>
        <DesktopUpdateDeliveryStatus v-else-if="updateAvailable && result" :delivery="delivery" :version="result.latestVersion" :language="language" :pending="pending" />
        <p v-if="reminderDescription" class="m-0 text-muted text-[12px] leading-[1.5]" role="status">
          {{ reminderDescription }}
        </p>
        <div class="flex flex-wrap items-center justify-between gap-[12px] w-full">
          <div v-if="updateAvailable" class="desktop-update-dialog__secondary-actions flex flex-wrap items-center gap-[8px]">
            <NDropdown v-if="!ignored && !outdated" :menu-props="() => ({ role: 'menu' })" :node-props="option => ({ 'role': 'menuitem', 'aria-disabled': option.disabled ? 'true' : 'false' })" trigger="click" :options="laterOptions" @select="selectLater">
              <NButton :disabled="pending || installing">
                {{ t('desktop.update.later') }}
                <template #icon>
                  <DesktopIcon :component="ChevronDown16Regular" :size="16" />
                </template>
              </NButton>
            </NDropdown>
            <NButton v-else :disabled="installing" @click="emit('update:show', false)">
              {{ t('desktop.update.later') }}
            </NButton>
            <NButton
              quaternary
              :disabled="pending || installing || outdated"
              @click="updateVersionReminder"
            >
              {{ t(ignored ? 'desktop.update.restore' : 'desktop.update.ignore') }}
            </NButton>
          </div>
          <div v-else class="flex-1" />

          <div class="desktop-update-dialog__primary-actions flex flex-wrap items-center gap-[8px]">
            <NButton v-if="outdated" type="primary" :disabled="pending" @click="emit('showLatest')">
              {{ t(newer ? 'desktop.update.viewLatest' : 'desktop.update.viewResult') }}
            </NButton>
            <NButton v-else-if="!updateAvailable" @click="emit('update:show', false)">
              {{ t('common.close') }}
            </NButton>
            <DesktopUpdateDeliveryActions
              v-else-if="updateAvailable && result"
              :delivery="delivery"
              :version="result.latestVersion"
              :language="language"
              :pending="pending"
              :manual-installation="manualInstallation"
              @check="emit('check')"
              @download="emit('download')"
              @cancel="emit('cancelDownload')"
              @install="emit('install')"
              @show-installation="emit('showInstallation')"
              @open-package="emit('openPackage')"
              @open-release="emit('openRelease', result.releaseUrl)"
            />
          </div>
        </div>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.desktop-update-dialog__icon-wrap.is-update {
  background: var(--buddy-accent-surface);
  color: var(--buddy-accent-text);
  border: 1px solid var(--buddy-accent-border, transparent);
}

.desktop-update-dialog__icon-wrap.is-latest {
  background: var(--buddy-status-success-surface);
  color: var(--buddy-status-success-text);
  border: 1px solid var(--buddy-status-success-border, transparent);
}

.desktop-update-dialog__card-title {
  letter-spacing: 0.02em;
}

.desktop-update-dialog__release-link {
  font-size: 12px;
}

.desktop-update-dialog__notes {
  --buddy-chat-final-font-size: 13px;
  --buddy-chat-final-line-height: 1.7;
}
</style>

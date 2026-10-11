<script setup lang="ts">
import type { DesktopUpdateCheckResult } from '@buddy-electron/shared/desktopUpdates'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ArrowDownload20Regular, ArrowUpRight20Regular, CheckmarkCircle20Regular } from '@vicons/fluent'
import { NButton, NModal, NScrollbar } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopMarkdownContent from '@/shared/ui/markdown/DesktopMarkdownContent.vue'

const props = defineProps<{
  language: BuddyLocale
  result: DesktopUpdateCheckResult | null
  show: boolean
  pending: boolean
  writeClipboardText: (text: string) => Promise<void>
}>()
const emit = defineEmits<{
  'openRelease': [url: string]
  'ignore': [version: string]
  'update:show': [show: boolean]
}>()
const { t } = useBuddyI18n(() => props.language)
const updateAvailable = computed(() => props.result?.status === 'update_available')
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    class="desktop-update-dialog"
    :style="{ width: 'min(42rem, calc(100vw - 2rem))' }"
    :title="t('desktop.update.title')"
    :auto-focus="false"
    @update:show="emit('update:show', $event)"
  >
    <template v-if="result">
      <!-- 发现新版本视图 -->
      <template v-if="updateAvailable">
        <header class="flex items-center gap-[14px] pt-[2px] pr-0 pb-[14px] pl-0">
          <div class="desktop-update-dialog__icon-wrap is-update flex items-center justify-center flex-none w-[44px] h-[44px] rounded-[12px]">
            <DesktopIcon :component="ArrowDownload20Regular" :size="22" aria-hidden="true" />
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-[8px]">
              <h2 class="m-0 text-strong text-[16px] font-600 leading-[1.35]">
                Lexora Buddy {{ result.latestVersion }}
              </h2>
              <span class="inline-flex items-center py-[2px] px-[7px] rounded-[9999px] bg-accent-surface text-accent-text text-[11px] font-600 leading-[1.3]">{{ t('desktop.update.newTag') }}</span>
            </div>
            <p class="mt-[3px] mr-0 mb-0 ml-0 text-muted text-[12px] leading-[1.5]">
              {{ t('desktop.update.currentVersion') }} v{{ result.currentVersion }}
            </p>
          </div>
        </header>

        <section class="rounded-[8px] border border-solid border-border bg-raised py-[12px] px-[14px]">
          <div class="flex items-center justify-between gap-[12px] mb-[8px]">
            <h3 class="desktop-update-dialog__card-title m-0 text-strong text-[12px] font-600">
              {{ t('desktop.update.releaseNotes') }}
            </h3>
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
          </div>

          <NScrollbar
            v-if="result.releaseNotes.trim()"
            :key="result.latestVersion"
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
          <div class="desktop-update-dialog__icon-wrap is-latest flex items-center justify-center flex-none w-[44px] h-[44px] rounded-[12px]">
            <DesktopIcon :component="CheckmarkCircle20Regular" :size="24" aria-hidden="true" />
          </div>
          <h2 class="mt-[12px] mr-0 mb-[4px] ml-0 text-strong text-[16px] font-600 leading-[1.35]">
            {{ t('desktop.update.latest') }}
          </h2>
          <p class="m-0 text-muted text-[13px] leading-[1.5]">
            {{ t('desktop.update.latestDescription') }} (v{{ result.currentVersion }})
          </p>
        </div>
      </template>
    </template>

    <template #footer>
      <div class="flex items-center justify-between gap-[12px] w-full">
        <NButton
          v-if="updateAvailable"
          quaternary
          :disabled="pending"
          @click="emit('ignore', result?.latestVersion ?? '')"
        >
          {{ t('desktop.update.ignore') }}
        </NButton>
        <div v-else class="flex-1" />

        <div class="flex items-center gap-[8px]">
          <NButton @click="emit('update:show', false)">
            {{ t('common.close') }}
          </NButton>
          <NButton
            v-if="updateAvailable"
            type="primary"
            :loading="pending"
            @click="emit('openRelease', result?.releaseUrl ?? '')"
          >
            {{ t('desktop.update.download') }}
          </NButton>
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

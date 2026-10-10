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
        <header class="desktop-update-dialog__header">
          <div class="desktop-update-dialog__icon-wrap is-update">
            <DesktopIcon :component="ArrowDownload20Regular" :size="22" aria-hidden="true" />
          </div>
          <div class="desktop-update-dialog__header-copy">
            <div class="desktop-update-dialog__title-row">
              <h2 class="desktop-update-dialog__version-title">
                Lexora Buddy {{ result.latestVersion }}
              </h2>
              <span class="desktop-update-dialog__badge">{{ t('desktop.update.newTag') }}</span>
            </div>
            <p class="desktop-update-dialog__meta">
              {{ t('desktop.update.currentVersion') }} v{{ result.currentVersion }}
            </p>
          </div>
        </header>

        <section class="desktop-update-dialog__card">
          <div class="desktop-update-dialog__card-header">
            <h3 class="desktop-update-dialog__card-title">
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
              class="desktop-update-dialog__notes"
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
          <p v-else class="desktop-update-dialog__notes-empty">
            {{ t('desktop.update.notesUnavailable') }}
          </p>
        </section>
      </template>

      <!-- 已是最新版本视图 -->
      <template v-else>
        <div class="desktop-update-dialog__latest-state">
          <div class="desktop-update-dialog__icon-wrap is-latest">
            <DesktopIcon :component="CheckmarkCircle20Regular" :size="24" aria-hidden="true" />
          </div>
          <h2 class="desktop-update-dialog__latest-title">
            {{ t('desktop.update.latest') }}
          </h2>
          <p class="desktop-update-dialog__latest-desc">
            {{ t('desktop.update.latestDescription') }} (v{{ result.currentVersion }})
          </p>
        </div>
      </template>
    </template>

    <template #footer>
      <div class="desktop-update-dialog__actions">
        <NButton
          v-if="updateAvailable"
          quaternary
          :disabled="pending"
          @click="emit('ignore', result?.latestVersion ?? '')"
        >
          {{ t('desktop.update.ignore') }}
        </NButton>
        <div v-else class="desktop-update-dialog__spacer" />

        <div class="desktop-update-dialog__primary-group">
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

<style scoped>
.desktop-update-dialog__header {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 2px 0 14px;
}

.desktop-update-dialog__icon-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 44px;
  height: 44px;
  border-radius: 12px;
}

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

.desktop-update-dialog__header-copy {
  min-width: 0;
  flex: 1;
}

.desktop-update-dialog__title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.desktop-update-dialog__version-title {
  margin: 0;
  color: var(--buddy-text-strong);
  font-size: 16px;
  font-weight: 600;
  line-height: 1.35;
}

.desktop-update-dialog__badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 9999px;
  background: var(--buddy-accent-surface);
  color: var(--buddy-accent-text);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.3;
}

.desktop-update-dialog__meta {
  margin: 3px 0 0;
  color: var(--buddy-text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.desktop-update-dialog__card {
  border-radius: 8px;
  border: 1px solid var(--buddy-border-subtle);
  background: var(--buddy-surface-raised);
  padding: 12px 14px;
}

.desktop-update-dialog__card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.desktop-update-dialog__card-title {
  margin: 0;
  color: var(--buddy-text-strong);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.desktop-update-dialog__release-link {
  font-size: 12px;
}

.desktop-update-dialog__notes {
  color: var(--buddy-text-primary);
  padding-right: 12px;
  overflow-wrap: anywhere;
  --buddy-chat-final-font-size: 13px;
  --buddy-chat-final-line-height: 1.7;
}

.desktop-update-dialog__notes-empty {
  margin: 0;
  color: var(--buddy-text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.desktop-update-dialog__latest-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 16px 0 12px;
}

.desktop-update-dialog__latest-title {
  margin: 12px 0 4px;
  color: var(--buddy-text-strong);
  font-size: 16px;
  font-weight: 600;
  line-height: 1.35;
}

.desktop-update-dialog__latest-desc {
  margin: 0;
  color: var(--buddy-text-secondary);
  font-size: 13px;
  line-height: 1.5;
}

.desktop-update-dialog__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}

.desktop-update-dialog__spacer {
  flex: 1;
}

.desktop-update-dialog__primary-group {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>

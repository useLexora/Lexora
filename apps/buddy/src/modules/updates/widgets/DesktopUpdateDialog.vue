<script setup lang="ts">
import type { DesktopUpdateCheckResult } from '@buddy-electron/shared/desktopUpdates'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton, NModal } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { updateReleaseHighlights } from '../model/updateReleaseNotes'

const props = defineProps<{
  language: BuddyLocale
  result: DesktopUpdateCheckResult | null
  show: boolean
  pending: boolean
}>()
const emit = defineEmits<{
  'openRelease': [url: string]
  'ignore': [version: string]
  'update:show': [show: boolean]
}>()
const { t } = useBuddyI18n(() => props.language)
const highlights = computed(() => updateReleaseHighlights(props.result?.releaseNotes ?? ''))
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    class="desktop-update-dialog"
    :style="{ width: 'min(32rem, calc(100vw - 2rem))' }"
    :title="t('desktop.update.title')"
    @update:show="emit('update:show', $event)"
  >
    <template v-if="result">
      <p class="desktop-update-dialog__status">
        {{ result.status === 'up_to_date' ? t('desktop.update.latest') : t('desktop.update.available') }}
      </p>
      <dl class="desktop-update-dialog__versions">
        <div><dt>{{ t('desktop.update.currentVersion') }}</dt><dd>{{ result.currentVersion }}</dd></div>
        <div><dt>{{ t('desktop.update.latestVersion') }}</dt><dd>{{ result.latestVersion }}</dd></div>
      </dl>
      <section v-if="result.status === 'update_available'" class="desktop-update-dialog__notes">
        <h3>{{ t('desktop.update.highlights') }}</h3>
        <ul v-if="highlights.length">
          <li v-for="(line, index) in highlights" :key="index">
            {{ line }}
          </li>
        </ul>
        <p v-else>
          {{ t('desktop.update.notesUnavailable') }}
        </p>
        <NButton text :disabled="pending" @click="emit('openRelease', result.releaseUrl)">
          {{ t('desktop.update.openRelease') }}
        </NButton>
      </section>
    </template>
    <template #footer>
      <div class="desktop-update-dialog__actions">
        <NButton v-if="result?.status === 'update_available'" quaternary :disabled="pending" @click="emit('ignore', result.latestVersion)">
          {{ t('desktop.update.ignore') }}
        </NButton>
        <div class="desktop-update-dialog__primary">
          <NButton @click="emit('update:show', false)">
            {{ t('common.close') }}
          </NButton>
          <NButton v-if="result?.status === 'update_available'" type="primary" :disabled="pending" @click="emit('openRelease', result.releaseUrl)">
            {{ t('desktop.update.download') }}
          </NButton>
        </div>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.desktop-update-dialog__status {
  margin: 0 0 1rem;
  color: var(--buddy-text-strong);
  font-size: 14px;
}
.desktop-update-dialog__versions {
  display: grid;
  gap: 0.5rem;
  margin: 0;
  font-size: 13px;
}
.desktop-update-dialog__versions div {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
}
.desktop-update-dialog__versions dt {
  color: var(--buddy-text-secondary);
}
.desktop-update-dialog__versions dd {
  margin: 0;
  font-family: var(--buddy-font-mono);
}
.desktop-update-dialog__notes {
  margin-top: 20px;
  border-top: 1px solid var(--buddy-border-subtle);
  padding-top: 12px;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.desktop-update-dialog__notes h3 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
}
.desktop-update-dialog__notes ul {
  margin: 0 0 12px;
  padding-left: 18px;
  color: var(--buddy-text-secondary);
  line-height: 1.7;
}
.desktop-update-dialog__notes p {
  color: var(--buddy-text-secondary);
}
.desktop-update-dialog__actions,
.desktop-update-dialog__primary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.desktop-update-dialog__actions {
  justify-content: space-between;
}
.desktop-update-dialog__primary {
  margin-left: auto;
}
</style>

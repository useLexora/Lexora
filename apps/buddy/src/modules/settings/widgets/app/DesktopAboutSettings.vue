<script setup lang="ts">
import type { DesktopAppInfo } from '@buddy-electron/shared/desktopApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton, NTag, useMessage } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useDesktopUpdatesContext } from '@/modules/updates'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import { BRAND_ASSET_URLS } from '@/shared/branding/brandAssets'

const props = defineProps<{
  appInfo: DesktopAppInfo | null
  language: BuddyLocale
}>()
const { t } = useBuddyI18n(() => props.language)
const api = requireDesktopApi()
const message = useMessage()
const updates = useDesktopUpdatesContext()
const checking = computed(() => updates.state.value?.checking ?? false)
const updateResult = computed(() => updates.state.value?.result ?? null)

async function checkForUpdates() {
  if (checking.value)
    return
  try {
    await updates.check()
  }
  catch {
    message.error(t('desktop.update.failed'))
  }
}

async function openLink(action: () => Promise<unknown>) {
  try {
    await action()
  }
  catch {
    message.error(t('desktop.command.failed'))
  }
}
</script>

<template>
  <section class="desktop-about-settings">
    <div class="desktop-about-settings__identity">
      <img :src="BRAND_ASSET_URLS.appIcon" alt="" draggable="false">
      <div>
        <h2>Lexora Buddy</h2>
        <div class="desktop-about-settings__version">
          <span>{{ t('desktop.about.version', { version: appInfo?.version ?? '—' }) }}</span>
          <NTag v-if="updateResult?.status === 'up_to_date'" size="small" type="success" :bordered="false" role="status">
            {{ t('desktop.update.latestTag') }}
          </NTag>
        </div>
      </div>
    </div>
    <div class="desktop-about-settings__actions">
      <NButton :loading="checking" :disabled="checking" @click="checkForUpdates">
        {{ t('desktop.update.title') }}
      </NButton>
      <NButton secondary @click="openLink(() => api.commands.execute('help.openDocumentation'))">
        {{ t('desktop.command.help.openDocumentation') }}
      </NButton>
      <NButton secondary @click="openLink(() => api.app.openFeedbackIssue(''))">
        {{ t('desktop.feedback.githubIssue') }}
      </NButton>
    </div>
    <div v-if="updateResult?.status === 'update_available'" class="desktop-about-settings__update" role="status">
      <span>{{ t('desktop.update.available') }}</span>
      <span>{{ t('desktop.about.version', { version: updateResult.latestVersion }) }}</span>
      <NButton text type="primary" @click="openLink(updates.openDetails)">
        {{ t('desktop.update.view') }}
      </NButton>
    </div>
    <div v-if="appInfo" class="desktop-about-settings__versions">
      <span>{{ t('desktop.about.electron', { version: appInfo.electronVersion }) }}</span>
      <span>{{ t('desktop.about.chromium', { version: appInfo.chromiumVersion }) }}</span>
      <span>{{ t('desktop.about.node', { version: appInfo.nodeVersion }) }}</span>
    </div>
  </section>
</template>

<style scoped>
.desktop-about-settings {
  display: grid;
  gap: 1.2rem;
}

.desktop-about-settings__identity {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.desktop-about-settings__identity img {
  width: 3.5rem;
  height: 3.5rem;
}

.desktop-about-settings__identity h2 {
  margin: 0 0 0.25rem;
  color: var(--buddy-text-strong);
  font-size: 1.15rem;
  font-weight: 650;
}

.desktop-about-settings__version {
  margin: 0;
  color: var(--buddy-text-secondary);
  font-size: 0.8rem;
}

.desktop-about-settings__actions,
.desktop-about-settings__version,
.desktop-about-settings__update,
.desktop-about-settings__versions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem 1rem;
}

.desktop-about-settings__update {
  color: var(--buddy-text-primary);
  font-size: 0.8rem;
}

.desktop-about-settings__versions {
  color: var(--buddy-text-muted);
  font-family: var(--buddy-font-mono);
  font-size: 0.7rem;
}
</style>

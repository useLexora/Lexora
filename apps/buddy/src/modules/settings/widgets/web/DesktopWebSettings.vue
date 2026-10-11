<script setup lang="ts">
import type { WebSettingsProps } from './typing'
import { NAlert, NButton, NSkeleton } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopTavilySettings from './DesktopTavilySettings.vue'
import DesktopWebFetchSettings from './DesktopWebFetchSettings.vue'
import DesktopWebSearchSettings from './DesktopWebSearchSettings.vue'

const props = defineProps<WebSettingsProps>()
const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <section class="desktop-web-settings grid gap-8">
    <NAlert v-if="error" type="error" :show-icon="false">
      {{ error }}
      <NButton text :disabled="busy" @click="load()">
        {{ t('desktop.agent.retry') }}
      </NButton>
    </NAlert>
    <template v-if="snapshot">
      <DesktopWebSearchSettings
        :sources="searchSources"
        :disabled="busy"
        :language="language"
        @toggle="setSearchEnabled"
        @reorder="reorderSearch"
      />
      <DesktopWebFetchSettings
        :settings="snapshot.settings.fetch"
        :tavily-key-configured="snapshot.tavilyKeyConfigured"
        :disabled="busy"
        :language="language"
        @toggle="setFetchEnabled"
      />
      <section class="grid gap-4">
        <h2 class="m-0 text-[0.92rem] font-600">
          {{ t('desktop.web.services') }}
        </h2>
        <DesktopTavilySettings
          :configured="snapshot.tavilyKeyConfigured"
          :disabled="busy"
          :language="language"
          :save-credential="saveCredential"
          :reveal-credential="revealCredential"
        />
      </section>
    </template>
    <NSkeleton v-else-if="busy" text :repeat="6" />
  </section>
</template>

<script setup lang="ts">
import type { WebSettings } from '@buddy-shared/network/webProtocol'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NSwitch } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopWebSpecializedReading from './DesktopWebSpecializedReading.vue'

const props = defineProps<{
  settings: Readonly<WebSettings['fetch']>
  tavilyKeyConfigured: boolean
  disabled: boolean
  language: BuddyLocale
}>()
const emit = defineEmits<{ toggle: [name: keyof WebSettings['fetch'], enabled: boolean] }>()
const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <section class="desktop-web-fetch grid gap-5">
    <header class="grid gap-[0.3rem]">
      <h2 class="m-0 text-[0.92rem] font-600">
        {{ t('desktop.web.fetch') }}
      </h2>
      <p class="desktop-web-fetch__description">
        {{ t('desktop.web.fetchDescription') }}
      </p>
    </header>
    <section class="grid gap-[0.65rem]">
      <h3 class="m-0 text-[0.82rem] font-600">
        {{ t('desktop.web.generalReading') }}
      </h3>
      <div class="overflow-hidden border border-solid border-border rounded-[0.65rem]">
        <div class="desktop-web-fetch__row flex items-center justify-between gap-6 py-[0.85rem] px-4 border-b-1 border-b-solid border-b-border last:border-b-0">
          <div class="desktop-web-fetch__copy min-w-0">
            <strong id="web-fetch-render">{{ t('desktop.web.render') }}</strong>
            <p>{{ t('desktop.web.renderDescription') }}</p>
          </div>
          <NSwitch :round="false" aria-labelledby="web-fetch-render" :value="settings.render" :disabled="disabled" @update:value="emit('toggle', 'render', $event)" />
        </div>
        <div class="desktop-web-fetch__row flex items-center justify-between gap-6 py-[0.85rem] px-4 border-b-1 border-b-solid border-b-border last:border-b-0">
          <div class="desktop-web-fetch__copy min-w-0">
            <strong id="web-fetch-remote">{{ t('desktop.web.remote') }}</strong>
            <p>{{ t(tavilyKeyConfigured ? 'desktop.web.remoteDescription' : 'desktop.web.remoteUnavailable') }}</p>
          </div>
          <NSwitch :round="false" aria-labelledby="web-fetch-remote" :value="tavilyKeyConfigured && settings.remote" :disabled="disabled || !tavilyKeyConfigured" @update:value="emit('toggle', 'remote', $event)" />
        </div>
      </div>
    </section>
    <DesktopWebSpecializedReading :language="language" />
  </section>
</template>

<style scoped lang="scss">
.desktop-web-fetch__description, .desktop-web-fetch__copy p { margin: 0; color: var(--buddy-text-secondary); font-size: 0.75rem; line-height: 1.65; }
.desktop-web-fetch__copy strong { font-size: 0.8rem; font-weight: 500; }
.desktop-web-fetch__copy p { margin-top: 0.25rem; }
</style>

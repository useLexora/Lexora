<script setup lang="ts">
import type { DesktopBrowserApi } from '@buddy-electron/shared/desktopApi'
import type { BrowserDataSummary } from '@buddy-shared/browser/browserData'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Cookies20Regular, Image20Regular, Info16Regular } from '@vicons/fluent'
import { NAlert, NButton, NCheckbox, NModal, NTooltip, useMessage } from 'naive-ui'
import { computed, onBeforeUnmount, onMounted, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { formatFileSize } from '@/shared/lib/formatFileSize'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ language: BuddyLocale, browser: Pick<DesktopBrowserApi, 'getDataSummary' | 'clearData'> }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const siteData = shallowRef(false)
const cache = shallowRef(true)
const summary = shallowRef<BrowserDataSummary | null>(null)
const loading = shallowRef(true)
const busy = shallowRef(false)
const error = shallowRef<'failed' | 'inUse' | null>(null)
const summaryFailed = shallowRef(false)
const selectionCount = computed(() => Number(siteData.value) + Number(cache.value))
let mounted = true

onBeforeUnmount(() => {
  mounted = false
})
onMounted(loadSummary)

async function loadSummary() {
  loading.value = true
  summaryFailed.value = false
  try {
    const result = await props.browser.getDataSummary()
    if (mounted)
      summary.value = result
  }
  catch {
    if (mounted)
      summaryFailed.value = true
  }
  finally {
    if (mounted)
      loading.value = false
  }
}

async function clear() {
  if (busy.value || !selectionCount.value)
    return
  busy.value = true
  error.value = null
  try {
    const result = await props.browser.clearData({ siteData: siteData.value, cache: cache.value })
    if (!result.ok) {
      if (mounted) {
        error.value = result.code === 'BROWSER_IN_USE' ? 'inUse' : 'failed'
        void loadSummary()
      }
      return
    }
    if (mounted) {
      message.success(t('desktop.browser.clearSucceeded'))
      emit('close')
    }
  }
  catch {
    if (mounted) {
      error.value = 'failed'
      void loadSummary()
    }
  }
  finally {
    if (mounted)
      busy.value = false
  }
}

function close() {
  if (!busy.value)
    emit('close')
}
</script>

<template>
  <NModal show preset="card" class="desktop-browser-clear-dialog" :title="t('desktop.browser.clearData')" :style="{ width: 'min(560px, calc(100vw - 32px))' }" :mask-closable="!busy" :close-on-esc="!busy" :closable="!busy" @close="close" @update:show="value => !value && close()">
    <div class="browser-clear">
      <div class="browser-clear__options">
        <div class="browser-clear__option" :class="{ 'is-disabled': busy }" @click="!busy && (siteData = !siteData)">
          <DesktopIcon class="browser-clear__icon" :component="Cookies20Regular" />
          <div class="browser-clear__copy">
            <div class="browser-clear__name">
              <strong id="browser-clear-site-data">{{ t('desktop.browser.siteData') }}</strong>
              <NTooltip :delay="200" style="max-width: min(20rem, calc(100vw - 3rem))">
                <template #trigger>
                  <NButton class="browser-clear__info" quaternary :aria-label="t('desktop.browser.dataInfo', { name: t('desktop.browser.siteData') })" :aria-description="t('desktop.browser.signOutNotice')" @click.stop>
                    <DesktopIcon :component="Info16Regular" />
                  </NButton>
                </template>
                {{ t('desktop.browser.signOutNotice') }}
              </NTooltip>
            </div>
            <small>{{ loading ? t('desktop.browser.calculating') : summary ? t('desktop.browser.cookieSites', { count: summary.cookieSiteCount }) : t('desktop.browser.siteDataDescription') }}</small>
          </div>
          <NCheckbox v-model:checked="siteData" :disabled="busy" aria-labelledby="browser-clear-site-data" @click.stop />
        </div>
        <div class="browser-clear__option" :class="{ 'is-disabled': busy }" @click="!busy && (cache = !cache)">
          <DesktopIcon class="browser-clear__icon" :component="Image20Regular" />
          <div class="browser-clear__copy">
            <div class="browser-clear__name">
              <strong id="browser-clear-cache">{{ t('desktop.browser.cache') }}</strong>
              <NTooltip :delay="200" style="max-width: min(20rem, calc(100vw - 3rem))">
                <template #trigger>
                  <NButton class="browser-clear__info" quaternary :aria-label="t('desktop.browser.dataInfo', { name: t('desktop.browser.cache') })" :aria-description="t('desktop.browser.cacheNotice')" @click.stop>
                    <DesktopIcon :component="Info16Regular" />
                  </NButton>
                </template>
                {{ t('desktop.browser.cacheNotice') }}
              </NTooltip>
            </div>
            <small>{{ loading ? t('desktop.browser.calculating') : summary ? t('desktop.browser.cacheSize', { size: formatFileSize(summary.cacheBytes) }) : t('desktop.browser.cacheDescription') }}</small>
          </div>
          <NCheckbox v-model:checked="cache" :disabled="busy" aria-labelledby="browser-clear-cache" @click.stop />
        </div>
      </div>
      <p v-if="summaryFailed" class="browser-clear__summary-error">
        {{ t('desktop.browser.summaryFailed') }}
      </p>
      <NAlert v-if="error" type="error" :show-icon="false">
        {{ t(error === 'inUse' ? 'desktop.browser.clearInUse' : 'desktop.browser.clearFailed') }}
      </NAlert>
      <footer class="browser-clear__footer">
        <span class="browser-clear__selection">{{ t('desktop.browser.selectedCount', { count: selectionCount }) }}</span>
        <NButton :disabled="busy" @click="close">
          {{ t('desktop.browser.cancel') }}
        </NButton>
        <NButton type="error" :disabled="!selectionCount" :loading="busy" @click="clear">
          {{ t('desktop.browser.deleteData') }}
        </NButton>
      </footer>
    </div>
  </NModal>
</template>

<style scoped>
.browser-clear { display: grid; gap: 1rem; }
.browser-clear__options { overflow: hidden; border: 1px solid var(--buddy-border-subtle); border-radius: 0.65rem; }
.browser-clear__option { display: flex; width: 100%; align-items: center; gap: 0.9rem; padding: 1.1rem 1rem; cursor: pointer; }
.browser-clear__option + .browser-clear__option { border-top: 1px solid var(--buddy-border-subtle); }
.browser-clear__option.is-disabled { cursor: wait; opacity: 0.65; }
.browser-clear__icon { flex: none; width: 1.4rem; height: 1.4rem; font-size: 1.25rem; color: var(--buddy-text-secondary); }
.browser-clear__copy { display: grid; flex: 1; min-width: 0; gap: 0.35rem; }
.browser-clear__name { display: flex; align-items: center; gap: 0.25rem; }
.browser-clear__info { width: 1.5rem; height: 1.5rem; flex: none; padding: 0; color: var(--buddy-text-secondary); border-radius: var(--buddy-icon-button-radius); }
.browser-clear__copy strong { color: var(--buddy-text-primary); font-size: 0.83rem; font-weight: 550; }
.browser-clear__copy small { color: var(--buddy-text-secondary); font-size: 0.72rem; line-height: 1.5; }
.browser-clear__summary-error { margin: 0; font-size: 0.72rem; color: var(--buddy-text-secondary); }
.browser-clear__footer { display: flex; gap: 0.6rem; align-items: center; padding-top: 0.25rem; }
.browser-clear__selection { margin-right: auto; color: var(--buddy-text-secondary); font-size: 0.7rem; }
</style>

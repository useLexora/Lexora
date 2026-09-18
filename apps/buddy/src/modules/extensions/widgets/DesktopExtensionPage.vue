<script setup lang="ts">
import type { ExtensionViewInput } from '@buddy-shared/extensions/extensionApi'
import { NButton, NEmpty } from 'naive-ui'
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'
import { useExtensionContext } from '../extensionContext'
import DesktopExtensionSurface from './DesktopExtensionSurface.vue'

const props = defineProps<{ extensionId: string }>()
const router = useRouter()
const { state, language } = useExtensionContext()
const viewId = crypto.randomUUID()
const plugin = computed(() => state.installed.value.find(item => item.manifest.id === props.extensionId && item.enabled && item.compatible))
const input = computed<ExtensionViewInput | null>(() => {
  const navigation = plugin.value?.manifest.contributes.navigation
  return navigation ? { viewId, extensionId: props.extensionId, viewType: navigation.view, resource: null, state: {}, stateVersion: 0 } : null
})
</script>

<template>
  <section class="extension-page" :data-extension-page="extensionId">
    <header class="extension-page__header">
      <strong>{{ plugin?.manifest.contributes.navigation?.title ?? (language === 'en-US' ? 'Plugin' : '插件') }}</strong>
    </header>
    <DesktopExtensionSurface v-if="input" :input="input" visible />
    <NEmpty v-else class="extension-page__empty" :description="language === 'en-US' ? 'This plugin is unavailable' : '此插件暂时不可用'">
      <template #extra>
        <NButton @click="router.push(desktopRouteLocations.extensions())">
          {{ language === 'en-US' ? 'Manage plugins' : '管理插件' }}
        </NButton>
      </template>
    </NEmpty>
  </section>
</template>

<style scoped>
.extension-page { display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; }
.extension-page__header { display: flex; align-items: center; min-height: var(--buddy-region-header-height); flex: none; padding: 0 20px; border-bottom: 1px solid var(--buddy-border-subtle); font-size: 14px; color: var(--buddy-text-strong); }
.extension-page__empty { margin: auto; }
</style>

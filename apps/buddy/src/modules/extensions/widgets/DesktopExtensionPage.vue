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
  <section class="extension-page flex flex-col w-full h-full min-h-0" :data-extension-page="extensionId">
    <header class="flex items-center flex-none py-0 px-[20px] border-b-1 border-b-solid border-b-border text-[14px] text-strong min-h-region-header">
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

<style scoped lang="scss">
.extension-page__empty { margin: auto; }
</style>

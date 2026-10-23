<script setup lang="ts">
import type { WorkbenchLauncherIcon } from '../common/workbench'
import { Apps20Regular, Code16Regular, Folder20Regular, Globe16Regular } from '@vicons/fluent'
import { computed, shallowRef, watch } from 'vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ icon?: WorkbenchLauncherIcon }>()
const failed = shallowRef(false)
const url = computed(() => typeof props.icon === 'object' ? props.icon.url : undefined)
watch(url, () => {
  failed.value = false
})
const icons = { changes: Code16Regular, folder: Folder20Regular, browser: Globe16Regular, extension: Apps20Regular }
const component = computed(() => typeof props.icon === 'string' ? icons[props.icon] : Apps20Regular)
</script>

<template>
  <img v-if="url && !failed" :src="url" alt="" class="w-4 h-4 flex-none object-contain" @error="failed = true">
  <DesktopIcon v-else :component="component" aria-hidden="true" />
</template>

<script setup lang="ts">
import type { SettingsModuleNode } from '../model/settingsRegistry'
import { computed, toRef } from 'vue'
import DesktopSettingsModuleLayout from '../layouts/DesktopSettingsModuleLayout.vue'
import { useProvideSettingsModule } from '../state/settingsModuleContext'
import { settingsPageRenderers } from './settingsPageRenderers'

const props = defineProps<{ module: SettingsModuleNode }>()
useProvideSettingsModule(toRef(() => props.module))
const renderer = computed(() => props.module.page ? settingsPageRenderers[props.module.page] : DesktopSettingsModuleLayout)
</script>

<template>
  <component :is="renderer" />
</template>

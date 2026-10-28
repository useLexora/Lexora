<script setup lang="ts">
import type { ExtensionInstallation } from '@buddy-shared/extensions/extensionInstallation'
import type { ExtensionPendingInstall } from '../state/useExtensionOperations'
import { NButton, NEllipsis, NSpin } from 'naive-ui'
import { computed } from 'vue'

const props = defineProps<{ installation: ExtensionPendingInstall, job?: ExtensionInstallation, language: string }>()
const emit = defineEmits<{ progress: [], dismiss: [] }>()
const en = computed(() => props.language === 'en-US')
const label = computed(() => {
  if (props.installation.error)
    return `${en.value ? 'Installation failed' : '安装失败'}: ${props.installation.error}`
  if (props.installation.phase === 'apply-update')
    return en.value ? 'Switching version…' : '正在切换版本…'
  const stage = props.job?.stage ?? 'compile'
  return (en.value
    ? { download: 'Downloading…', validate: 'Validating…', review: 'Preparing installation…', compile: 'Preparing plugin…', install: 'Installing…', completed: 'Finishing installation…' }
    : { download: '正在获取插件…', validate: '正在校验…', review: '正在准备安装…', compile: '正在准备插件…', install: '正在安装…', completed: '正在完成安装…' })[stage]
})
</script>

<template>
  <div class="flex min-w-0 items-center gap-2 text-[12px]" :class="installation.error ? 'text-danger' : 'text-muted'" data-testid="extension-installation-status" :data-status="installation.error ? 'failed' : 'running'">
    <NSpin v-if="!installation.error" :size="14" class="flex-none" />
    <span role="status" aria-live="polite" class="min-w-0 flex-1">
      <NEllipsis>{{ label }}</NEllipsis>
    </span>
    <NButton v-if="installation.installationId" text size="tiny" @click="emit('progress')">
      {{ en ? 'Details' : '详情' }}
    </NButton>
    <NButton v-if="installation.error" text size="tiny" @click="emit('dismiss')">
      {{ en ? 'Dismiss' : '关闭' }}
    </NButton>
  </div>
</template>

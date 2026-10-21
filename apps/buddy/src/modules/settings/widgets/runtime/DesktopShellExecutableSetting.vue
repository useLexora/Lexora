<script setup lang="ts">
import type { ExtensionSettingValue } from '@buddy-shared/extensions/extensionSettings'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton } from 'naive-ui'
import { onScopeDispose, shallowRef } from 'vue'

const props = defineProps<{
  value: string
  detectedPath?: string
  disabled: boolean
  language: BuddyLocale
  controlAttrs: { 'aria-labelledby': string, 'aria-describedby': string | undefined }
  pick: () => Promise<string | null>
  save: (value: ExtensionSettingValue) => Promise<'saved' | 'failed' | 'stale'>
}>()
const picking = shallowRef(false)
const error = shallowRef(false)
let disposed = false
onScopeDispose(() => disposed = true)

async function choose() {
  if (props.disabled || picking.value)
    return
  picking.value = true
  error.value = false
  try {
    const value = await props.pick()
    if (!disposed && value !== null)
      await props.save(value)
  }
  catch { error.value = true }
  finally { picking.value = false }
}
</script>

<template>
  <div class="grid min-w-0 gap-2">
    <output v-bind="controlAttrs" class="block min-w-0">
      <code v-if="value || detectedPath" class="block text-[12px] break-all">{{ value || detectedPath }}</code>
      <span v-else class="text-[12px] text-muted">{{ language === 'zh-CN' ? '未找到路径' : 'No path found' }}</span>
    </output>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span class="text-[12px] text-muted">{{ value ? (language === 'zh-CN' ? '指定路径' : 'Custom path') : (language === 'zh-CN' ? '自动检测' : 'Automatic') }}</span>
      <NButton size="tiny" :disabled="disabled || picking" :loading="picking" @click="choose">
        {{ language === 'zh-CN' ? '选择文件' : 'Choose file' }}
      </NButton>
      <NButton v-if="value" text size="tiny" :disabled="disabled || picking" @click="save('')">
        {{ language === 'zh-CN' ? '恢复自动检测' : 'Use automatic detection' }}
      </NButton>
    </div>
    <small v-if="error" class="text-danger text-[12px]" role="alert">{{ language === 'zh-CN' ? '无法选择文件，请重试。原有配置未改变。' : 'Could not choose a file. Retry; the saved configuration is unchanged.' }}</small>
  </div>
</template>

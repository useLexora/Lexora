<script setup lang="ts">
import type { FileOpeningChoice, FileOpeningLocation, FileOpeningProvider, FileOpeningSnapshot } from '@buddy-shared/files/fileOpening'
import { fileOpeningExtension, fileOpeningTitle, resolveFileOpening } from '@buddy-shared/files/fileOpening'
import { NSelect } from 'naive-ui'
import { computed, h, shallowRef, useId } from 'vue'
import DesktopSettingCell from '../shared/DesktopSettingCell.vue'
import DesktopFileOpeningOption from './DesktopFileOpeningOption.vue'

const props = defineProps<{
  extension: string
  location: FileOpeningLocation
  snapshot: FileOpeningSnapshot
  language: string
  disabled: boolean
  save: (choice: FileOpeningChoice) => Promise<void>
}>()
const english = computed(() => props.language === 'en-US')
const label = computed(() => props.location === 'inline'
  ? english.value ? 'File preview' : '文件内预览'
  : english.value ? 'Open separately' : '独立打开')
const pending = shallowRef(false)
const error = shallowRef('')
const statusId = useId()
const resolution = computed(() => resolveFileOpening(props.snapshot, props.extension, props.location))
const candidates = computed(() => props.snapshot.providers.filter(provider => provider.available && provider.locations.includes(props.location) && fileOpeningExtension(props.extension, [provider]) !== null))
function option(provider: FileOpeningProvider | undefined, id: string, unavailable = false) {
  const name = provider ? fileOpeningTitle(provider, props.language) : id
  let source = provider?.builtin ? english.value ? 'Built-in' : '内置' : provider?.extensionName ?? provider?.extensionId ?? ''
  if (provider?.extensionId && props.snapshot.providers.some(other => other.extensionId && other.extensionId !== provider.extensionId && (other.extensionName ?? other.extensionId) === source))
    source = `${source} (${provider.extensionId})`
  const label = unavailable ? `${name} · ${english.value ? 'Unavailable' : '不可用'}` : name
  return {
    value: id,
    label: () => h(DesktopFileOpeningOption, { label, source, builtin: provider?.builtin ?? false }),
    disabled: unavailable,
  }
}
const options = computed(() => {
  const values = candidates.value.map(provider => option(provider, provider.id))
  const { preferredId, unavailable } = resolution.value
  if (preferredId && unavailable) {
    const provider = props.snapshot.providers.find(candidate => candidate.id === preferredId)
    values.push(option(provider, preferredId, true))
  }
  return values
})
const unavailableHint = computed(() => {
  if (!resolution.value.unavailable)
    return undefined
  const fallback = resolution.value.provider
  return english.value
    ? `Saved choice kept (${resolution.value.preferredId}). ${fallback ? `Temporarily using ${fileOpeningTitle(fallback, props.language)}.` : 'No built-in preview is available.'}`
    : `已保留原选择（${resolution.value.preferredId}）。${fallback ? `暂用${fileOpeningTitle(fallback, props.language)}。` : '暂无内置预览。'}`
})

async function update(value: string) {
  if (pending.value || props.disabled || !options.value.some(option => option.value === value && !option.disabled))
    return
  pending.value = true
  error.value = ''
  try {
    await props.save({ extension: props.extension, location: props.location, providerId: value })
  }
  catch {
    error.value = english.value ? 'Could not save. Your previous choice is unchanged. Try again.' : '保存失败，原选择未改变，请重试。'
  }
  finally {
    pending.value = false
  }
}
</script>

<template>
  <DesktopSettingCell class="grid-cols-1" :label="`${extension} · ${label}`" :error="error" :description="unavailableHint">
    <template #default="{ controlAttrs }">
      <span class="desktop-file-opening-location hidden text-[12px] text-muted">{{ label }}</span>
      <NSelect
        v-bind="controlAttrs" :value="resolution.preferredId ?? resolution.provider?.id ?? null" :options="options"
        :disabled="disabled || pending || !candidates.length" :loading="pending" :consistent-menu-width="false"
        :placeholder="english ? 'No available opener' : '暂无可用打开方式'"
        :aria-describedby="[controlAttrs['aria-describedby'], unavailableHint && statusId].filter(Boolean).join(' ') || undefined"
        @update:value="update"
      />
    </template>
    <template v-if="unavailableHint" #hint>
      <small :id="statusId" class="text-warning text-[12px] leading-[1.5] [overflow-wrap:anywhere]">{{ unavailableHint }}</small>
    </template>
  </DesktopSettingCell>
</template>

<style scoped lang="scss">
.desktop-file-opening-location {
  @container (max-width: 540px) {
    display: block;
  }
}
</style>

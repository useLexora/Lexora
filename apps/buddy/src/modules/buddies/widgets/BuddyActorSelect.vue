<script setup lang="ts">
import type { SelectOption } from 'naive-ui'
import { NSelect } from 'naive-ui'
import { computed, h } from 'vue'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import { useBuddiesContext } from '../buddiesContext'
import BuddyAvatar from './BuddyAvatar.vue'

const props = defineProps<{ value: string | null, disabled?: boolean }>()
const emit = defineEmits<{ 'update:value': [value: string | null] }>()
const { buddies, catalog, ready, refresh } = useBuddiesContext()
const { language } = useDesktopUi()
const defaultValue = '__application_default__'
const defaultLabel = computed(() => language.value === 'en-US' ? 'Application default actor' : '应用默认主角')
const unavailableLabel = computed(() => language.value === 'en-US' ? 'Unavailable actor' : '主角不可用')
const selected = computed(() => props.value ?? defaultValue)
const options = computed(() => {
  const active = buddies.value.filter(buddy => buddy.kind === 'actor' && buddy.enabled && !buddy.deletedAt)
  const result: SelectOption[] = [{ value: defaultValue, label: defaultLabel.value }, ...active.map(buddy => ({ value: buddy.id, label: buddy.name }))]
  if (props.value && !active.some(buddy => buddy.id === props.value))
    result.push({ value: props.value, label: `${buddies.value.find(buddy => buddy.id === props.value)?.name ?? props.value} · ${unavailableLabel.value}`, disabled: true })
  return result
})
function renderLabel(option: SelectOption) {
  const id = option.value === defaultValue ? catalog.value?.defaultBuddyId : String(option.value)
  const buddy = buddies.value.find(buddy => buddy.id === id)
  return h('span', { class: 'flex items-center gap-2 min-w-0' }, [h(BuddyAvatar, { buddyId: id, src: buddy?.avatar, class: 'size-5' }), h('span', { class: 'truncate' }, String(option.label))])
}
</script>

<template>
  <NSelect :value="selected" :options="options" :render-label="renderLabel" :disabled="disabled || !ready" filterable :aria-label="language === 'en-US' ? 'Actor' : '主角'" @update:show="show => show && refresh()" @update:value="emit('update:value', $event === defaultValue ? null : $event)" />
</template>

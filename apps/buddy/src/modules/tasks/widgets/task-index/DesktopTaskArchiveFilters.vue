<script setup lang="ts">
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Search20Regular } from '@vicons/fluent'
import { NInput, NSelect } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ spaces: readonly LocalSpace[], disabled: boolean, language: BuddyLocale }>()
const query = defineModel<string>('query', { required: true })
const spaceId = defineModel<string | null | undefined>('spaceId')
const { t } = useBuddyI18n(() => props.language)
const value = computed({
  get: () => spaceId.value === undefined ? 'all' : spaceId.value === null ? 'unbound' : `space:${spaceId.value}`,
  set: (value: string) => { spaceId.value = value === 'all' ? undefined : value === 'unbound' ? null : value.slice(6) },
})
const options = computed(() => [
  { value: 'all', label: t('desktop.archive.allSpaces') },
  ...[...props.spaces].sort((a, b) => a.name.localeCompare(b.name, props.language)).map(space => ({
    value: `space:${space.id}`,
    label: space.name,
  })),
  { value: 'unbound', label: t('desktop.archive.unbound') },
])
</script>

<template>
  <div class="desktop-task-archive-filters grid grid-cols-[minmax(0,1fr)_10rem] gap-3">
    <NInput v-model:value="query" clearable :disabled="disabled" :placeholder="t('desktop.archive.search')" :aria-label="t('desktop.archive.search')" class="min-w-0">
      <template #prefix>
        <DesktopIcon :component="Search20Regular" :size="18" class="text-muted" />
      </template>
    </NInput>
    <NSelect v-model:value="value" :options="options" :disabled="disabled" :aria-label="t('desktop.archive.filterSpace')" class="min-w-0" data-testid="task-archive-space-filter" />
  </div>
</template>

<style scoped lang="scss">
@container (max-width: 360px) {
  .desktop-task-archive-filters {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

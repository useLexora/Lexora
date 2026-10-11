<script setup lang="ts">
import type { LocalProvider, LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'

import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Checkmark16Regular, Search20Regular } from '@vicons/fluent'
import { NInput } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { modelKey } from '../../model/modelSelection'
import { useModelPicker } from './useModelPicker'

const props = defineProps<{
  language: BuddyLocale
  models: ReadonlyArray<LocalRuntimeModelOption>
  providers: ReadonlyArray<LocalProvider>
  selectedModelId: string | null
}>()

const emit = defineEmits<{
  select: [modelId: string]
}>()

const { t } = useBuddyI18n(() => props.language)
const { query, activeProviderId, visibleGroups, activeGroup } = useModelPicker(props)
</script>

<template>
  <section class="desktop-model-picker grid overflow-hidden w-[min(29rem,_calc(100vw_-_18rem))] min-w-88 max-h-[min(25rem,_62vh)] border-1 border-solid border-border rounded-menu bg-raised shadow-overlay">
    <div class="desktop-model-picker__search border-b-1 border-b-solid border-b-border p-[0.55rem]">
      <NInput
        v-model:value="query"
        clearable
        size="small"
        :placeholder="t('desktop.chat.searchModels')"
      >
        <template #prefix>
          <DesktopIcon :component="Search20Regular" />
        </template>
      </NInput>
    </div>

    <div v-if="visibleGroups.length" class="grid h-[min(17.75rem,_calc(62vh_-_6.5rem))] min-h-0 grid-cols-[minmax(8.5rem,_0.8fr)_minmax(12rem,_1.35fr)] overflow-hidden">
      <div class="desktop-model-picker__providers border-r-1 border-r-solid border-r-border bg-subtle grid content-start gap-[0.15rem] overflow-x-hidden overflow-y-auto p-[0.45rem]">
        <button
          v-for="group in visibleGroups"
          :key="group.providerId"
          class="desktop-model-picker__provider min-h-[2.2rem] ui-menu-option gap-[0.6rem] px-[0.55rem] py-[0.42rem]"
          :class="{ 'is-active font-650': activeGroup?.providerId === group.providerId }"
          type="button"
          :aria-pressed="activeGroup?.providerId === group.providerId"
          @click="activeProviderId = group.providerId"
        >
          <span class="min-w-0 truncate text-[0.76rem]">{{ group.providerName }}</span>
          <small class="text-muted text-[0.66rem]">{{ group.models.length }}</small>
        </button>
      </div>

      <div class="desktop-model-picker__models grid content-start gap-[0.15rem] overflow-x-hidden overflow-y-auto p-[0.45rem]" role="menu">
        <button
          v-for="model in activeGroup?.models ?? []"
          :key="modelKey(model)"
          class="desktop-model-picker__model h-13 min-h-13 ui-menu-option gap-[0.6rem] px-[0.55rem] py-[0.42rem]"
          type="button"
          role="menuitemradio"
          :aria-checked="selectedModelId === modelKey(model)"
          @click="emit('select', modelKey(model))"
        >
          <span class="desktop-model-picker__model-copy grid min-w-0 flex-1 gap-[0.08rem]">
            <strong class="min-w-0 truncate text-[0.78rem] font-650">{{ model.displayName }}</strong>
            <small class="min-w-0 truncate text-muted text-[0.66rem]">{{ model.modelId }}</small>
          </span>
          <DesktopIcon
            v-if="selectedModelId === modelKey(model)"
            :component="Checkmark16Regular"
          />
        </button>
      </div>
    </div>

    <span v-else class="min-h-32 text-muted text-[0.72rem] py-10 px-4 text-center">
      {{ t('desktop.chat.noMatchingModels') }}
    </span>
  </section>
</template>

<style scoped lang="scss">
.desktop-model-picker {
  @media (max-width: 760px) {
    width: min(24rem, calc(100vw - 2rem));
    min-width: 20rem;
  }
}
</style>

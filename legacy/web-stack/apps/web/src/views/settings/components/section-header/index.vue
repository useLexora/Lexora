<script setup lang="ts">
import type {
  UserSettingsSectionHeaderProps,
  UserSettingsSectionHeaderSlots,
} from './typing'

const props = defineProps<UserSettingsSectionHeaderProps>()

defineSlots<UserSettingsSectionHeaderSlots>()
</script>

<template>
  <div class="user-settings-section-header mb-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
    <div class="min-w-0">
      <h2 class="m-0 text-lg font-bold text-main">
        {{ props.title }}
      </h2>
      <p v-if="props.description" class="mt-1.5 text-sm leading-6 text-secondary">
        {{ props.description }}
      </p>
    </div>

    <div v-if="$slots.aside" class="w-full shrink-0 sm:ml-auto sm:w-auto">
      <slot name="aside" />
    </div>
  </div>
</template>

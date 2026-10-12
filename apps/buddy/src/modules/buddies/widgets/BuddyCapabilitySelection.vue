<script setup lang="ts">
import { Settings20Regular } from '@vicons/fluent'
import { NButton, NTag } from 'naive-ui'
import { computed, useId } from 'vue'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopSegmentedControl from '@/shared/ui/segmented-control/DesktopSegmentedControl.vue'
import { buddyLabels } from '../buddyLabels'

withDefaults(defineProps<{
  label: string
  description?: string
  mode: 'all' | 'selected' | 'none'
  summary: string
  tags?: readonly string[]
  configureLabel: string
  disabled: boolean
  showConfigure?: boolean
  emptySelectedHint?: string
}>(), {
  description: undefined,
  tags: () => [],
  showConfigure: undefined,
  emptySelectedHint: undefined,
})

const emit = defineEmits<{
  'update:mode': [mode: 'all' | 'selected' | 'none']
  'configure': []
}>()

const { language } = useDesktopUi()
const labels = computed(() => buddyLabels(language.value))
const labelId = useId()
const descriptionId = useId()
const modes = computed(() => (['all', 'selected', 'none'] as const).map(value => ({ value, label: labels.value[value] })))

function selectMode(nextMode: 'all' | 'selected' | 'none') {
  emit('update:mode', nextMode)
}
</script>

<template>
  <div class="grid min-w-0 content-start gap-3 p-4">
    <strong :id="labelId" class="text-[13px] font-600 text-fg">{{ label }}</strong>
    <DesktopSegmentedControl
      class="w-full"
      :aria-labelledby="labelId"
      :aria-describedby="descriptionId"
      :model-value="mode"
      :options="modes"
      :disabled="disabled"
      @update:model-value="selectMode"
    />

    <div :id="descriptionId" class="text-[12px] text-muted leading-relaxed">
      <p v-if="mode !== 'selected'" class="m-0">
        {{ summary }}
      </p>
      <p v-else-if="description" class="m-0">
        {{ description }}
      </p>
    </div>
    <div v-if="mode === 'selected'" class="flex flex-wrap items-center gap-1.5 min-w-0">
      <template v-if="tags && tags.length">
        <NTag
          v-for="tag in tags.slice(0, 7)"
          :key="tag"
          size="small"
          :bordered="false"
          class="max-w-[150px] truncate"
        >
          {{ tag }}
        </NTag>
        <NTag v-if="tags.length > 7" size="small" :bordered="false" class="text-muted font-normal">
          +{{ tags.length - 7 }}
        </NTag>
      </template>
      <span v-else class="text-[12px] text-muted font-normal">
        {{ emptySelectedHint ?? (label.includes('Skill') || label.includes('技能') ? labels.noSelectedSkillsHint : labels.noSelectedToolsHint) }}
      </span>
    </div>
    <NButton
      v-if="showConfigure ?? (mode === 'selected')"
      size="small"
      secondary
      class="justify-self-start"
      :disabled="disabled"
      @click="emit('configure')"
    >
      <template #icon>
        <DesktopIcon :component="Settings20Regular" />
      </template>
      {{ configureLabel }}
    </NButton>
  </div>
</template>

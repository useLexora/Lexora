<script setup lang="ts">
import { NSwitch, NTooltip } from 'naive-ui'
import { computed, useId } from 'vue'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import { buddyLabels } from '../buddyLabels'

defineProps<{ enabled: boolean, disabled: boolean, isDefault: boolean, busy: boolean }>()
const emit = defineEmits<{ enabled: [value: boolean] }>()
const { language } = useDesktopUi()
const labels = computed(() => buddyLabels(language.value))
const labelId = useId()
</script>

<template>
  <NTooltip :disabled="!isDefault">
    <template #trigger>
      <div class="flex shrink-0 items-center gap-2" data-testid="buddy-profile-actions">
        <span :id="labelId" class="text-[12px] text-muted">{{ labels.enabled }}</span>
        <NSwitch :aria-labelledby="labelId" :value="enabled" size="small" :loading="busy" :disabled="disabled || isDefault" :aria-disabled="disabled || isDefault" @update:value="emit('enabled', $event)" />
      </div>
    </template>
    {{ labels.defaultEnabledHint }}
  </NTooltip>
</template>

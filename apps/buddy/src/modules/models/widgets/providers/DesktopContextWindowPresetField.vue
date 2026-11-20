<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton, NInputNumber } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import {
  coefficientForContext,
  CONTEXT_WINDOW_PRESETS,
  contextTokensFromCustomPaste,
  contextWindowFromCoefficient,
  contextWindowPresetId,
  MAX_CONTEXT_COEFFICIENT,
  MIN_CONTEXT_COEFFICIENT,
} from './contextWindowPreset'

const props = defineProps<{
  disabled?: boolean
  language: BuddyLocale
}>()
const contextWindow = defineModel<number>({ required: true })
const { t } = useBuddyI18n(() => props.language)
const forceCustom = ref(false)
let emitted: number | null = null
const selected = computed(() => forceCustom.value ? 'custom' : contextWindowPresetId(contextWindow.value))
const coefficient = computed(() => coefficientForContext(contextWindow.value))

function assignContext(tokens: number) {
  if (tokens === contextWindow.value)
    return
  emitted = tokens
  contextWindow.value = tokens
}

function selectPreset(tokens: number) {
  forceCustom.value = false
  assignContext(tokens)
}

function selectCustom() {
  forceCustom.value = true
}

function assignCoefficient(value: number | null) {
  if (value == null)
    return
  forceCustom.value = true
  assignContext(contextWindowFromCoefficient(value))
}

function step(delta: number) {
  assignCoefficient(coefficient.value + delta)
}

function onPaste(event: ClipboardEvent) {
  const tokens = contextTokensFromCustomPaste(event.clipboardData?.getData('text') ?? '')
  if (tokens == null)
    return
  event.preventDefault()
  forceCustom.value = true
  assignContext(tokens)
}

watch(contextWindow, (value) => {
  if (value === emitted) {
    emitted = null
    return
  }
  forceCustom.value = false
})
</script>

<template>
  <div class="desktop-context-window-preset" role="group" :aria-label="t('desktop.providers.contextWindow')">
    <div class="desktop-context-window-preset__options">
      <NButton
        v-for="preset in CONTEXT_WINDOW_PRESETS"
        :key="preset.id"
        size="small"
        :type="selected === preset.id ? 'primary' : 'default'"
        :disabled="disabled"
        @click="selectPreset(preset.tokens)"
      >
        {{ preset.label }}
      </NButton>
      <NButton
        size="small"
        :type="selected === 'custom' ? 'primary' : 'default'"
        :disabled="disabled"
        @click="selectCustom"
      >
        {{ t('desktop.providers.contextWindowCustom') }}
      </NButton>
    </div>
    <div v-if="selected === 'custom'" class="desktop-context-window-preset__custom" @paste.capture="onPaste">
      <NButton
        size="small"
        :disabled="disabled || coefficient <= MIN_CONTEXT_COEFFICIENT"
        :aria-label="t('desktop.providers.decreaseContextWindow')"
        @click="step(-1)"
      >
        −
      </NButton>
      <NInputNumber
        :value="coefficient"
        :min="MIN_CONTEXT_COEFFICIENT"
        :max="MAX_CONTEXT_COEFFICIENT"
        :precision="0"
        :show-button="false"
        :disabled="disabled"
        @update:value="assignCoefficient"
      />
      <span>K</span>
      <NButton
        size="small"
        :disabled="disabled || coefficient >= MAX_CONTEXT_COEFFICIENT"
        :aria-label="t('desktop.providers.increaseContextWindow')"
        @click="step(1)"
      >
        +
      </NButton>
    </div>
  </div>
</template>

<style scoped>
.desktop-context-window-preset {
  display: grid;
  gap: 0.55rem;
}

.desktop-context-window-preset__options {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.desktop-context-window-preset__custom {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.desktop-context-window-preset__custom :deep(.n-input-number) {
  width: 5.5rem;
}

.desktop-context-window-preset__custom > span {
  color: var(--buddy-text-secondary);
  font-size: 0.75rem;
  font-weight: 620;
}
</style>

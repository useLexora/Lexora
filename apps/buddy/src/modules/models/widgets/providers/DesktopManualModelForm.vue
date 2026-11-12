<script setup lang="ts">
import type { LocalCustomProviderModel } from '@buddy-shared/providers/providerApi'
import type { ProviderModelType } from '@buddy-shared/providers/providerModelType'

import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton, NCheckbox, NInput, NSelect } from 'naive-ui'
import { computed, reactive } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { DEFAULT_CONTEXT_WINDOW, outputTokensForContext } from './contextWindowPreset'
import DesktopContextWindowPresetField from './DesktopContextWindowPresetField.vue'

const props = defineProps<{
  allowChat?: boolean
  language: BuddyLocale
  saving: boolean
}>()
const emit = defineEmits<{
  save: [model: LocalCustomProviderModel]
}>()
const { t } = useBuddyI18n(() => props.language)
const typeOptions = computed(() => (props.allowChat === false ? ['transcription', 'speech'] as const : ['chat', 'transcription', 'speech', 'image-generation'] as const).map(value => ({ value, label: t(`desktop.providers.modelTypes.${value}`) })))
const form = reactive({
  type: (props.allowChat === false ? 'transcription' : 'chat') as ProviderModelType,
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  id: '',
  image: false,
  name: '',
  reasoning: false,
})
const maxTokens = computed(() => outputTokensForContext(form.contextWindow))
const valid = computed(() => Boolean(
  form.id.trim()
  && (form.type !== 'chat' || (form.contextWindow > 0 && maxTokens.value <= form.contextWindow)),
))

function save() {
  if (!valid.value)
    return
  emit('save', {
    type: form.type,
    id: form.id.trim(),
    input: form.type === 'chat' && form.image ? ['text', 'image'] : ['text'],
    reasoning: form.type === 'chat' && form.reasoning,
    ...(form.name.trim() ? { name: form.name.trim() } : {}),
    ...(form.type !== 'chat' ? {} : { contextWindow: form.contextWindow, maxTokens: maxTokens.value }),
  })
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat(props.language).format(value)
}
</script>

<template>
  <div class="desktop-manual-model-form grid gap-4">
    <div class="desktop-manual-model-form__grid grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[0.8rem]">
      <label class="desktop-manual-model-form__field grid gap-[0.35rem]">
        <span>{{ t('desktop.providers.modelId') }}</span>
        <NInput v-model:value="form.id" placeholder="model-id" />
      </label>
      <label class="desktop-manual-model-form__field grid gap-[0.35rem]">
        <span>{{ t('desktop.providers.modelName') }}</span>
        <NInput v-model:value="form.name" :placeholder="t('desktop.providers.modelNameOptional')" />
      </label>
    </div>

    <label class="desktop-manual-model-form__field grid gap-[0.35rem]">
      <span>{{ t('desktop.providers.modelType') }}</span>
      <NSelect v-model:value="form.type" :options="typeOptions" />
    </label>
    <p v-if="form.type === 'image-generation'" class="m-0 text-muted text-[0.75rem]">
      {{ t('desktop.providers.imageProtocolHint') }}
    </p>
    <div v-if="form.type === 'chat'" class="desktop-manual-model-form__capabilities">
      <NCheckbox v-model:checked="form.reasoning">
        {{ t('desktop.providers.reasoning') }}
      </NCheckbox>
      <NCheckbox v-model:checked="form.image">
        {{ t('desktop.providers.imageInput') }}
      </NCheckbox>
    </div>

    <div v-if="form.type === 'chat'" class="grid gap-[0.85rem]">
      <label class="desktop-manual-model-form__field grid gap-[0.35rem]">
        <span>{{ t('desktop.providers.contextWindow') }}</span>
        <DesktopContextWindowPresetField v-model="form.contextWindow" :language="language" :disabled="saving" />
      </label>
      <div class="desktop-manual-model-form__field grid gap-[0.35rem]">
        <span>{{ t('desktop.providers.maxTokens') }}</span>
        <strong>{{ formatTokens(maxTokens) }}</strong>
      </div>
    </div>

    <div class="desktop-manual-model-form__actions justify-end">
      <NButton type="primary" :disabled="!valid" :loading="saving" @click="save">
        {{ t('desktop.providers.addModel') }}
      </NButton>
    </div>
  </div>
</template>

<style scoped lang="scss">
.desktop-manual-model-form__field > span {
  color: var(--buddy-text-secondary);
  font-size: 0.7rem;
}

.desktop-manual-model-form__field > strong {
  color: var(--buddy-text-strong);
  font-size: 0.9rem;
  font-variant-numeric: tabular-nums;
  font-weight: 620;
}

.desktop-manual-model-form__field :deep(.n-input) {
  width: 100%;
}

.desktop-manual-model-form__capabilities :deep(.n-checkbox-box) {
  border-radius: 3px;
}

.desktop-manual-model-form__capabilities,
.desktop-manual-model-form__actions {
  display: flex;
  align-items: center;
  gap: 1rem;
}

@media (max-width: 700px) {
  .desktop-manual-model-form__grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

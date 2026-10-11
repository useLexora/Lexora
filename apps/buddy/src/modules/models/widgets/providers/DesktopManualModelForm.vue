<script setup lang="ts">
import type { LocalCustomProviderModel } from '@buddy-shared/providers/providerApi'

import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton, NCheckbox, NCollapse, NCollapseItem, NInput, NInputNumber } from 'naive-ui'
import { computed, reactive } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{
  language: BuddyLocale
  saving: boolean
}>()
const emit = defineEmits<{
  save: [model: LocalCustomProviderModel]
}>()
const { t } = useBuddyI18n(() => props.language)
const form = reactive({
  contextWindow: null as number | null,
  id: '',
  image: false,
  maxTokens: null as number | null,
  name: '',
  reasoning: false,
})
const valid = computed(() => Boolean(
  form.id.trim()
  && (form.contextWindow === null || form.contextWindow > 0)
  && (form.maxTokens === null || form.maxTokens > 0)
  && (
    form.contextWindow === null
    || form.maxTokens === null
    || form.maxTokens <= form.contextWindow
  ),
))

function save() {
  if (!valid.value)
    return
  emit('save', {
    id: form.id.trim(),
    input: form.image ? ['text', 'image'] : ['text'],
    reasoning: form.reasoning,
    ...(form.name.trim() ? { name: form.name.trim() } : {}),
    ...(form.contextWindow === null ? {} : { contextWindow: form.contextWindow }),
    ...(form.maxTokens === null ? {} : { maxTokens: form.maxTokens }),
  })
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

    <div class="desktop-manual-model-form__capabilities">
      <NCheckbox v-model:checked="form.reasoning">
        {{ t('desktop.providers.reasoning') }}
      </NCheckbox>
      <NCheckbox v-model:checked="form.image">
        {{ t('desktop.providers.imageInput') }}
      </NCheckbox>
    </div>

    <NCollapse arrow-placement="right">
      <NCollapseItem :title="t('desktop.providers.advancedModelSettings')" name="advanced">
        <div class="desktop-manual-model-form__grid grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[0.8rem]">
          <label class="desktop-manual-model-form__field grid gap-[0.35rem]">
            <span>{{ t('desktop.providers.contextWindow') }}</span>
            <NInputNumber
              v-model:value="form.contextWindow"
              :min="1"
              :placeholder="t('desktop.providers.contextWindowDefault')"
            />
          </label>
          <label class="desktop-manual-model-form__field grid gap-[0.35rem]">
            <span>{{ t('desktop.providers.maxTokens') }}</span>
            <NInputNumber
              v-model:value="form.maxTokens"
              :min="1"
              :placeholder="t('desktop.providers.maxTokensDefault')"
            />
          </label>
        </div>
      </NCollapseItem>
    </NCollapse>

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

.desktop-manual-model-form__field :deep(.n-input),
.desktop-manual-model-form__field :deep(.n-input-number) {
  width: 100%;
}

.desktop-manual-model-form :deep(.n-collapse-item) {
  margin-left: 0;
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

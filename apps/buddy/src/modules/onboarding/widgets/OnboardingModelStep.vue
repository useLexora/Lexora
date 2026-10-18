<script setup lang="ts">
import type { ModelProvidersStore } from '@/modules/models'
import { Add20Regular, ChevronDown16Regular, PlugConnected24Regular } from '@vicons/fluent'
import { NButton, NPopover } from 'naive-ui'
import { computed, shallowRef, useId } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { modelKey } from '@/modules/models'
import { DesktopModelPicker, DesktopProviderAddDialog, DesktopProviderAuthDialog } from '@/modules/models/ui'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ providers: ModelProvidersStore }>()
const { t } = useBuddyI18n(props.providers.language)
const showAdd = shallowRef(false)
const resumeId = shallowRef<string | null>(null)
const savingModel = shallowRef(false)
const showModelPicker = shallowRef(false)
const modelLabelId = useId()
const modelValueId = useId()
const connected = computed(() => props.providers.providers.value.filter(provider => provider.added))
const selectedModelLabel = computed(() => {
  const model = props.providers.models.value.find(model => modelKey(model) === props.providers.defaultModelId.value)
  if (!model)
    return t('onboarding.selectModel')
  const provider = props.providers.providers.value.find(provider => provider.id === model.providerId)
  return `${model.displayName} · ${provider?.displayName ?? model.providerId}`
})
const authProviderName = computed(() => props.providers.providers.value.find(provider => provider.id === props.providers.authChallenge.value?.providerId)?.displayName ?? null)
function add(providerId: string | null = null) {
  resumeId.value = providerId
  showAdd.value = true
}
async function selectModel(value: string) {
  if (savingModel.value)
    return
  savingModel.value = true
  try {
    if (await props.providers.setDefaultModel(value))
      showModelPicker.value = false
  }
  finally { savingModel.value = false }
}
</script>

<template>
  <div class="grid gap-5">
    <div v-if="!connected.length" class="grid justify-items-start gap-4 rounded-[12px] bg-subtle p-6">
      <DesktopIcon :component="PlugConnected24Regular" :size="28" class="text-accent-text" />
      <div class="grid gap-2">
        <strong class="text-[16px] font-600">{{ t('onboarding.connectTitle') }}</strong>
        <p class="m-0 text-[13px] leading-relaxed text-muted">
          {{ t('onboarding.connectDescription') }}
        </p>
      </div>
      <NButton type="primary" @click="add()">
        {{ t('onboarding.connect') }}
      </NButton>
    </div>
    <div v-else class="grid gap-3">
      <article v-for="provider in connected" :key="provider.id" class="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-solid border-border p-4">
        <div class="grid min-w-0 gap-1">
          <strong class="truncate text-[14px]">{{ provider.displayName }}</strong>
          <span class="text-[12px] text-muted">{{ provider.setupComplete ? t('desktop.providers.enabledModelSummary', { enabled: provider.enabledModelCount, total: provider.modelCount }) : t('desktop.providers.continueSetup') }}</span>
        </div>
        <NButton v-if="!provider.setupComplete" size="small" @click="add(provider.id)">
          {{ t('desktop.providers.continueSetup') }}
        </NButton>
        <span v-else class="flex-none text-[12px] text-accent-text">{{ t('onboarding.connected') }}</span>
      </article>
      <NButton class="justify-self-start" secondary @click="add()">
        <template #icon>
          <DesktopIcon :component="Add20Regular" />
        </template>
        {{ t('desktop.providers.addService') }}
      </NButton>
    </div>
    <div v-if="providers.models.value.length" class="grid gap-2">
      <span :id="modelLabelId" class="text-[14px] font-600">{{ t('onboarding.model') }}</span>
      <NPopover v-model:show="showModelPicker" trigger="click" placement="bottom-start" raw :show-arrow="false" :disabled="savingModel" to=".buddy-app">
        <template #trigger>
          <NButton class="onboarding-model-trigger w-full" :loading="savingModel" :disabled="savingModel" :aria-labelledby="`${modelLabelId} ${modelValueId}`" :aria-expanded="showModelPicker" aria-haspopup="menu">
            <span :id="modelValueId" class="min-w-0 flex-1 truncate text-left">{{ selectedModelLabel }}</span>
            <DesktopIcon :component="ChevronDown16Regular" class="ml-2 shrink-0 text-muted" />
          </NButton>
        </template>
        <DesktopModelPicker :language="providers.language.value" :models="providers.models.value" :providers="providers.providers.value" :selected-model-id="providers.defaultModelId.value" :disabled="savingModel" @select="selectModel" @keydown.stop />
      </NPopover>
    </div>
    <p class="m-0 text-[12px] leading-relaxed text-muted">
      {{ t(providers.models.value.length ? 'onboarding.modelReadyHint' : 'onboarding.modelHint') }}
    </p>
    <DesktopProviderAddDialog v-model:show="showAdd" :provider-settings="providers" :resume-provider-id="resumeId" />
    <DesktopProviderAuthDialog :challenge="providers.authChallenge.value" :provider-name="authProviderName" :language="providers.language.value" @cancel="providers.cancelAuth" @submit="providers.respondToAuth" />
  </div>
</template>

<style scoped lang="scss">
.onboarding-model-trigger :deep(.n-button__content) {
  width: 100%;
  min-width: 0;
}
</style>

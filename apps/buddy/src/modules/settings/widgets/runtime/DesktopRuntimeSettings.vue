<script setup lang="ts">
import type { RuntimePreferences } from '@buddy-shared/runtime/runtimePreferences'
import type { ApplicationSettingsProps } from '../app/typing'
import { NSelect } from 'naive-ui'
import { computed, shallowRef, useId } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<ApplicationSettingsProps>()
const { t } = useBuddyI18n(() => props.language)
const labelId = useId()
const descriptionId = useId()
const pending = shallowRef(false)
const failed = shallowRef(false)
const modes = computed(() => [
  { label: t('desktop.settings.runtime.cacheWarmingOff'), value: 'off' },
  { label: t('desktop.settings.runtime.cacheWarmingStreaming'), value: 'streaming' },
])

async function updateCacheWarming(cacheWarming: RuntimePreferences['cacheWarming']) {
  if (pending.value)
    return
  pending.value = true
  failed.value = false
  try {
    failed.value = !await props.updateSettings({ runtime: { cacheWarming } })
  }
  finally {
    pending.value = false
  }
}
</script>

<template>
  <section v-if="config" class="runtime-settings">
    <h2>{{ t('desktop.settings.runtime.context') }}</h2>
    <div class="runtime-settings__row" data-testid="cache-warming-setting">
      <div class="runtime-settings__copy">
        <strong :id="labelId">{{ t('desktop.settings.runtime.cacheWarming') }}</strong>
        <small :id="descriptionId">{{ t('desktop.settings.runtime.cacheWarmingDescription') }}</small>
      </div>
      <div class="runtime-settings__control">
        <NSelect
          :aria-labelledby="labelId"
          :aria-describedby="descriptionId"
          :value="config.runtime.cacheWarming"
          :options="modes"
          :loading="pending"
          :disabled="pending"
          @update:value="updateCacheWarming"
        />
        <small v-if="failed" class="is-error" role="alert">{{ error ?? t('desktop.settings.saveFailed') }}</small>
      </div>
    </div>
  </section>
</template>

<style scoped>
.runtime-settings {
  display: grid;
  gap: 0.8rem;
  container-type: inline-size;
}

.runtime-settings h2 {
  margin: 0;
  font-size: 0.92rem;
}

.runtime-settings__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(10rem, 19rem);
  align-items: center;
  gap: 2rem;
  border: 1px solid var(--buddy-border-subtle);
  border-radius: 0.65rem;
  padding: 0.75rem 0.9rem;
  background: var(--buddy-surface-base);
}

.runtime-settings__copy,
.runtime-settings__control {
  display: grid;
  gap: 0.25rem;
}

.runtime-settings strong {
  color: var(--buddy-text-primary);
  font-size: 0.8rem;
  font-weight: 600;
}

.runtime-settings small {
  color: var(--buddy-text-secondary);
  font-size: 0.7rem;
  line-height: 1.5;
}

.runtime-settings .is-error {
  color: var(--buddy-status-danger-text);
  text-align: right;
}

@container (max-width: 560px) {
  .runtime-settings__row {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.7rem;
  }
}
</style>

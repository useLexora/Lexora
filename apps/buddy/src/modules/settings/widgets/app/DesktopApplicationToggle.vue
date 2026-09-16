<script setup lang="ts">
import type { ApplicationSettingsProps } from './typing'
import { NSwitch } from 'naive-ui'
import { shallowRef, useId } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<ApplicationSettingsProps & {
  field: 'launchAtLogin' | 'developerToolsEnabled'
  label: string
  description: string
}>()
const { t } = useBuddyI18n(() => props.language)
const labelId = useId()
const pending = shallowRef(false)
const failed = shallowRef(false)

async function update(value: boolean) {
  if (pending.value)
    return
  pending.value = true
  failed.value = false
  try {
    failed.value = !await props.updateSettings({ desktop: { [props.field]: value } })
  }
  finally {
    pending.value = false
  }
}
</script>

<template>
  <div v-if="config" class="desktop-application-toggle">
    <div class="desktop-application-toggle__copy">
      <strong :id="labelId">{{ label }}</strong>
      <small>{{ description }}</small>
    </div>
    <NSwitch :aria-labelledby="labelId" :round="false" :value="config.desktop[field]" :loading="pending" :disabled="pending" @update:value="update" />
    <small v-if="failed" class="desktop-application-toggle__error" role="alert">
      {{ error ?? t('desktop.settings.saveFailed') }}
    </small>
  </div>
</template>

<style scoped>
.desktop-application-toggle {
  display: grid;
  min-height: 4rem;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.55rem 2rem;
  border: 1px solid var(--buddy-border-subtle);
  border-radius: 0.65rem;
  padding: 0.9rem;
  background: var(--buddy-surface-base);
}

.desktop-application-toggle__copy {
  display: grid;
  gap: 0.25rem;
}

.desktop-application-toggle strong {
  color: var(--buddy-text-primary);
  font-size: 0.8rem;
  font-weight: 600;
}

.desktop-application-toggle small {
  color: var(--buddy-text-secondary);
  font-size: 0.7rem;
  line-height: 1.5;
}

.desktop-application-toggle .desktop-application-toggle__error {
  grid-column: 1 / -1;
  color: var(--buddy-status-danger-text);
}
</style>

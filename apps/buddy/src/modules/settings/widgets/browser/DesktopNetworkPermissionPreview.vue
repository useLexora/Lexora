<script setup lang="ts">
import type { NetworkPermissions } from '@buddy-shared/permissions/networkPermissions'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { findNetworkPermissionRule, NETWORK_OPERATIONS, normalizeNetworkHost, resolveNetworkPermission } from '@buddy-shared/permissions/networkPermissions'
import { NButton, NInput, NModal } from 'naive-ui'
import { computed, shallowRef, useId } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{ settings: NetworkPermissions, language: BuddyLocale, draft?: boolean }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useBuddyI18n(() => props.language)
const inputId = useId()
const host = shallowRef('')
const normalized = computed(() => normalizeNetworkHost(host.value))
const invalid = computed(() => !!host.value && !normalized.value)
const matched = computed(() => normalized.value ? findNetworkPermissionRule(props.settings, normalized.value) : undefined)
const decisions = computed(() => normalized.value
  ? NETWORK_OPERATIONS.map(operation => ({ operation, decision: resolveNetworkPermission(props.settings, normalized.value!, operation) }))
  : [])
</script>

<template>
  <NModal show preset="card" data-testid="network-permission-preview" :title="t('desktop.browser.testHost')" :style="{ width: 'min(520px, calc(100vw - 32px))' }" @close="emit('close')" @update:show="value => !value && emit('close')">
    <section class="grid gap-5">
      <p :id="`${inputId}-description`" class="m-0 text-[0.8rem] leading-relaxed text-muted">
        {{ t(draft ? 'desktop.browser.testDraftDescription' : 'desktop.browser.testHostDescription') }}
      </p>
      <div class="grid gap-2">
        <label :for="inputId">{{ t('desktop.browser.testHostLabel') }}</label>
        <NInput v-model:value="host" :input-props="{ 'id': inputId, 'aria-describedby': `${inputId}-description${invalid ? ` ${inputId}-error` : ''}`, 'aria-invalid': invalid }" :placeholder="t('desktop.browser.hostPlaceholder')" :status="invalid ? 'error' : undefined" />
        <p v-if="invalid" :id="`${inputId}-error`" class="m-0 text-[0.75rem] leading-relaxed text-danger" role="alert">
          {{ t('desktop.browser.invalidHost') }}
        </p>
      </div>
      <div v-if="normalized" class="grid gap-4 text-[0.8rem] leading-relaxed" role="status">
        <p class="m-0 break-all">
          {{ normalized }} · {{ matched ? t('desktop.browser.matchedRule', { pattern: matched.pattern }) : t('desktop.browser.matchedDefaults') }}
        </p>
        <dl class="m-0 grid grid-cols-3 gap-4">
          <div v-for="item in decisions" :key="item.operation" class="grid gap-1">
            <dt class="text-muted">
              {{ t(`desktop.browser.operation.${item.operation}`) }}
            </dt>
            <dd class="m-0">
              {{ t(`desktop.browser.permission.${item.decision}`) }}
            </dd>
          </div>
        </dl>
      </div>
      <footer class="flex justify-end">
        <NButton @click="emit('close')">
          {{ t('common.close') }}
        </NButton>
      </footer>
    </section>
  </NModal>
</template>

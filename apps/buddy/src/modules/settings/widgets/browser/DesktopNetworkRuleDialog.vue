<script setup lang="ts">
import type { NetworkPermissionRule, NetworkPermissions } from '@buddy-shared/permissions/networkPermissions'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { networkPermissionsSchema } from '@buddy-shared/permissions/networkPermissions'
import { Info20Regular } from '@vicons/fluent'
import { NButton, NInput, NModal, NPopover, NSelect } from 'naive-ui'
import { computed, shallowRef, useId } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopNetworkPermissionPreview from './DesktopNetworkPermissionPreview.vue'
import DesktopNetworkPermissionSelect from './DesktopNetworkPermissionSelect.vue'

const props = defineProps<{
  rule?: NetworkPermissionRule
  settings: NetworkPermissions
  language: BuddyLocale
  pending: boolean
  save: (settings: NetworkPermissions) => Promise<boolean>
}>()
const emit = defineEmits<{ close: [] }>()
const { t } = useBuddyI18n(() => props.language)
const formId = useId()
const draft = shallowRef<NetworkPermissionRule>(props.rule
  ? { ...props.rule }
  : { id: crypto.randomUUID(), match: 'exact', pattern: '', access: 'ask', download: 'ask', upload: 'ask' })
const moreOptions = shallowRef(!!props.rule && (props.rule.match !== 'exact' || props.rule.download !== 'ask' || props.rule.upload !== 'ask'))
const showPreview = shallowRef(false)
const failed = shallowRef(false)
const matchOptions = computed(() => (['exact', 'subdomains', 'regex'] as const).map(value => ({
  label: t(`desktop.browser.match.${value}`),
  value,
})))
const validation = computed(() => networkPermissionsSchema.safeParse({
  ...props.settings,
  rules: props.rule
    ? props.settings.rules.map(rule => rule.id === draft.value.id ? draft.value : rule)
    : [...props.settings.rules, draft.value],
}))
const patternError = computed(() => {
  if (validation.value.success || !draft.value.pattern)
    return null
  const issue = validation.value.error.issues[0]!
  if (issue.code === 'too_big' && issue.path[0] === 'rules')
    return t('desktop.browser.ruleLimit')
  if (issue.message === 'duplicate_pattern')
    return t('desktop.browser.duplicatePattern')
  if (!draft.value.pattern.trim())
    return t('desktop.browser.patternRequired')
  return draft.value.match === 'regex' ? t('desktop.browser.invalidRegex') : t('desktop.browser.invalidHost')
})
const staleDraft = computed(() => !!props.rule && !props.settings.rules.some(rule => rule.id === draft.value.id))

function change(patch: Partial<NetworkPermissionRule>) {
  draft.value = { ...draft.value, ...patch }
}

async function submit() {
  if (!validation.value.success || props.pending || staleDraft.value)
    return
  failed.value = false
  if (await props.save(validation.value.data))
    emit('close')
  else
    failed.value = true
}

function close() {
  if (!props.pending)
    emit('close')
}
</script>

<template>
  <NModal show preset="card" data-testid="network-rule-dialog" :title="t(rule ? 'desktop.browser.editRule' : 'desktop.browser.addPermission')" :style="{ width: 'min(520px, calc(100vw - 32px))' }" :mask-closable="!pending" :closable="!pending" :close-on-esc="!pending" @close="close" @update:show="value => !value && close()">
    <form class="grid gap-5" @submit.prevent="submit">
      <p class="m-0 text-[0.8rem] text-muted">
        {{ t('desktop.browser.permissionScope') }}
      </p>
      <div class="grid gap-2">
        <label :id="`${formId}-pattern-label`" :for="`${formId}-pattern`">{{ t('desktop.browser.domainPattern') }}</label>
        <NInput :value="draft.pattern" :disabled="pending" :status="patternError ? 'error' : undefined" :placeholder="t('desktop.browser.hostPlaceholder')" :input-props="{ 'id': `${formId}-pattern`, 'aria-labelledby': `${formId}-pattern-label`, 'aria-describedby': `${formId}-pattern-feedback`, 'aria-invalid': !!patternError }" @update:value="change({ pattern: $event })" />
        <p :id="`${formId}-pattern-feedback`" class="m-0 text-[0.75rem] leading-relaxed" :class="patternError ? 'text-danger' : 'text-muted'" :role="patternError ? 'alert' : undefined">
          {{ patternError || t(draft.match === 'regex' ? 'desktop.browser.regexPatternDescription' : 'desktop.browser.patternDescription') }}
        </p>
      </div>
      <div class="grid gap-2">
        <span :id="`${formId}-access`">{{ t('desktop.browser.operation.access') }}</span>
        <DesktopNetworkPermissionSelect :language="language" :labelled-by="`${formId}-access`" :value="draft.access" :disabled="pending" @change="change({ access: $event })" />
      </div>
      <div v-if="moreOptions" class="grid gap-5">
        <div class="grid gap-2">
          <div class="flex items-center gap-1">
            <span :id="`${formId}-match`">{{ t('desktop.browser.matchMode') }}</span>
            <NPopover v-if="draft.match === 'regex'" trigger="click" placement="bottom-start">
              <template #trigger>
                <NButton quaternary size="small" class="buddy-icon-button" :aria-label="t('desktop.browser.regexSyntaxHelp')">
                  <DesktopIcon :component="Info20Regular" :size="18" />
                </NButton>
              </template>
              <p class="m-0 max-w-[26rem] break-words text-[0.75rem] leading-relaxed">
                {{ t('desktop.browser.regexSyntax') }}
              </p>
            </NPopover>
          </div>
          <NSelect :aria-labelledby="`${formId}-match`" :virtual-scroll="false" :value="draft.match" :options="matchOptions" :disabled="pending" @update:value="change({ match: $event })" />
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div v-for="operation in (['download', 'upload'] as const)" :key="operation" class="grid gap-2">
            <span :id="`${formId}-${operation}`">{{ t(`desktop.browser.operation.${operation}`) }}</span>
            <DesktopNetworkPermissionSelect :language="language" :labelled-by="`${formId}-${operation}`" :value="draft[operation]" :disabled="pending" @change="change({ [operation]: $event })" />
          </div>
        </div>
        <p class="m-0 text-[0.75rem] leading-relaxed text-muted">
          {{ t('desktop.browser.transferBoundary') }}
        </p>
        <div>
          <NButton text size="small" aria-haspopup="dialog" @click="showPreview = true">
            {{ t('desktop.browser.testHost') }}
          </NButton>
        </div>
        <DesktopNetworkPermissionPreview v-if="showPreview" :settings="validation.success && !staleDraft ? validation.data : settings" :language="language" :draft="validation.success && !staleDraft" @close="showPreview = false" />
      </div>
      <p v-if="staleDraft || failed" class="m-0 text-[0.75rem] text-danger" role="alert">
        {{ t(staleDraft ? 'desktop.browser.ruleRemoved' : 'desktop.browser.permissionSaveFailed') }}
      </p>
      <footer class="flex flex-wrap items-center justify-end gap-3">
        <NButton text class="mr-auto" :aria-expanded="moreOptions" @click="moreOptions = !moreOptions">
          {{ t(moreOptions ? 'desktop.browser.fewerOptions' : 'desktop.browser.moreOptions') }}
        </NButton>
        <NButton :disabled="pending" @click="close">
          {{ t('desktop.browser.cancel') }}
        </NButton>
        <NButton type="primary" attr-type="submit" :disabled="pending || !validation.success || staleDraft" :loading="pending">
          {{ t('desktop.browser.saveRule') }}
        </NButton>
      </footer>
    </form>
  </NModal>
</template>

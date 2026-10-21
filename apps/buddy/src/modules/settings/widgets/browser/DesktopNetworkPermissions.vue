<script setup lang="ts">
import type { NetworkOperation, NetworkPermissionDecision, NetworkPermissionRule, NetworkPermissions } from '@buddy-shared/permissions/networkPermissions'
import type { GlobalThemeOverrides } from 'naive-ui'
import type { DeepReadonly } from 'vue'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NETWORK_OPERATIONS, networkPermissionsSchema } from '@buddy-shared/permissions/networkPermissions'
import { Delete20Regular, Info20Regular, MoreHorizontal20Regular } from '@vicons/fluent'
import { NButton, NDropdown, NPopover, NTable, NTooltip } from 'naive-ui'
import { computed, shallowRef, useId } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'
import DesktopNetworkPermissionPreview from './DesktopNetworkPermissionPreview.vue'
import DesktopNetworkPermissionSelect from './DesktopNetworkPermissionSelect.vue'
import DesktopNetworkRuleDialog from './DesktopNetworkRuleDialog.vue'

const props = defineProps<{
  value: DeepReadonly<NetworkPermissions>
  language: BuddyLocale
  pending: boolean
  save: (settings: NetworkPermissions) => Promise<boolean>
}>()
const { t } = useBuddyI18n(() => props.language)
const tableId = useId()
const tableTheme: GlobalThemeOverrides['Table'] = {
  borderColor: 'var(--buddy-border-subtle)',
  borderRadius: '0',
  thColor: 'transparent',
  tdColor: 'transparent',
  thTextColor: 'var(--buddy-text-secondary)',
  thFontWeight: '500',
  fontSizeSmall: '0.8rem',
  thPaddingSmall: '0.75rem 0.9rem',
  tdPaddingSmall: '0.75rem 0.9rem',
}
const settings = computed(() => networkPermissionsSchema.parse(props.value))
const failed = shallowRef(false)
const saving = shallowRef(false)
const busy = computed(() => props.pending || saving.value)
const editor = shallowRef<{ rule?: NetworkPermissionRule } | null>(null)
const showPreview = shallowRef(false)
const rows = computed(() => [
  { key: 'defaults', rule: null, label: t('desktop.browser.defaultPermissions'), decisions: settings.value.defaults },
  ...settings.value.rules.map(rule => ({ key: `rule-${rule.id}`, rule, label: rule.pattern, decisions: rule })),
])

async function save(value: NetworkPermissions): Promise<boolean> {
  if (busy.value)
    return false
  failed.value = false
  saving.value = true
  try {
    const succeeded = await props.save(value)
    failed.value = !succeeded
    return succeeded
  }
  catch {
    failed.value = true
    return false
  }
  finally {
    saving.value = false
  }
}

function updatePermission(rule: NetworkPermissionRule | null, operation: NetworkOperation, value: NetworkPermissionDecision) {
  void save(rule
    ? { ...settings.value, rules: settings.value.rules.map(current => current.id === rule.id ? { ...current, [operation]: value } : current) }
    : { ...settings.value, defaults: { ...settings.value.defaults, [operation]: value } })
}

function openEditor(rule?: NetworkPermissionRule) {
  failed.value = false
  editor.value = { rule }
}

function ruleActions(id: string) {
  const index = settings.value.rules.findIndex(rule => rule.id === id)
  return [
    { key: 'edit', label: t('desktop.browser.editRule') },
    { key: 'up', label: t('desktop.browser.moveRuleUp'), disabled: index === 0 },
    { key: 'down', label: t('desktop.browser.moveRuleDown'), disabled: index === settings.value.rules.length - 1 },
  ]
}

function actOnRule(id: string, action: string | number) {
  if (busy.value)
    return
  const rules = [...settings.value.rules]
  const index = rules.findIndex(rule => rule.id === id)
  const rule = rules[index]
  if (!rule)
    return
  if (action === 'edit') {
    openEditor(rule)
    return
  }
  const target = index + (action === 'up' ? -1 : 1)
  if (target < 0 || target >= rules.length)
    return
  rules[index] = rules[target]!
  rules[target] = rule
  void save({ ...settings.value, rules })
}

function remove(id: string) {
  void save({ ...settings.value, rules: settings.value.rules.filter(rule => rule.id !== id) })
}
</script>

<template>
  <section class="grid min-w-0 gap-3" data-testid="network-permissions">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-1">
        <h2 :id="`${tableId}-heading`" class="m-0 text-[0.92rem]">
          {{ t('desktop.browser.networkPermissions') }}
        </h2>
        <NPopover trigger="click" placement="bottom-start">
          <template #trigger>
            <NButton quaternary size="small" class="buddy-icon-button" :aria-label="t('desktop.browser.permissionHelp')">
              <DesktopIcon :component="Info20Regular" :size="18" />
            </NButton>
          </template>
          <div class="grid max-w-[26rem] gap-3 text-[0.75rem] leading-relaxed">
            <p class="m-0">
              {{ t('desktop.browser.networkPermissionsDescription') }}
            </p>
            <p class="m-0">
              {{ t('desktop.browser.rulePriority') }}
            </p>
            <p class="m-0">
              {{ t('desktop.browser.transferBoundary') }}
            </p>
          </div>
        </NPopover>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <NButton aria-haspopup="dialog" @click="showPreview = true">
          {{ t('desktop.browser.testHost') }}
        </NButton>
        <NButton :disabled="busy || settings.rules.length >= 100" @click="openEditor()">
          {{ t('desktop.browser.addRule') }}
        </NButton>
      </div>
    </div>
    <p class="m-0 text-[0.75rem] leading-relaxed text-muted">
      {{ t('desktop.browser.permissionScope') }}
    </p>
    <DesktopSettingsGroup>
      <div class="min-w-0 overflow-x-auto">
        <NTable size="small" :bordered="false" :bottom-bordered="false" :theme-overrides="tableTheme" :aria-labelledby="`${tableId}-heading`" class="min-w-[50rem] table-fixed">
          <colgroup>
            <col>
            <col v-for="operation in NETWORK_OPERATIONS" :key="operation" class="w-[11rem]">
            <col class="w-[5.5rem]">
          </colgroup>
          <thead>
            <tr>
              <th scope="col">
                {{ t('desktop.browser.domainPattern') }}
              </th>
              <th v-for="operation in NETWORK_OPERATIONS" :id="`${tableId}-${operation}`" :key="operation" scope="col">
                {{ t(`desktop.browser.operation.${operation}`) }}
              </th>
              <th scope="col">
                <span class="sr-only">{{ t('desktop.browser.ruleActions') }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in rows" :key="row.key">
              <td :id="`${tableId}-row-${index}`">
                <span class="break-all">{{ row.label }}</span>
                <span v-if="row.rule && row.rule.match !== 'exact'" class="mt-1 block text-[0.7rem] text-muted">{{ t(`desktop.browser.match.${row.rule.match}`) }}</span>
              </td>
              <td v-for="operation in NETWORK_OPERATIONS" :key="operation">
                <DesktopNetworkPermissionSelect :language="language" :labelled-by="`${tableId}-row-${index} ${tableId}-${operation}`" :value="row.decisions[operation]" :disabled="busy" @change="updatePermission(row.rule, operation, $event)" />
              </td>
              <td>
                <div v-if="row.rule" class="flex justify-end gap-1">
                  <NDropdown trigger="click" :options="ruleActions(row.rule.id)" @select="actOnRule(row.rule.id, $event)">
                    <NButton quaternary size="small" class="buddy-icon-button" :disabled="busy" :aria-label="t('desktop.browser.ruleActions')">
                      <DesktopIcon :component="MoreHorizontal20Regular" :size="18" />
                    </NButton>
                  </NDropdown>
                  <NTooltip>
                    <template #trigger>
                      <NButton quaternary size="small" class="buddy-icon-button" :disabled="busy" :aria-label="t('desktop.browser.deleteRule')" @click="remove(row.rule.id)">
                        <DesktopIcon :component="Delete20Regular" :size="18" />
                      </NButton>
                    </template>
                    {{ t('desktop.browser.deleteRule') }}
                  </NTooltip>
                </div>
              </td>
            </tr>
          </tbody>
        </NTable>
      </div>
    </DesktopSettingsGroup>
    <p v-if="failed && !editor" class="m-0 text-[0.75rem] text-danger" role="alert">
      {{ t('desktop.browser.permissionSaveFailed') }}
    </p>
    <p v-if="settings.rules.length >= 100" class="m-0 text-[0.75rem] text-muted">
      {{ t('desktop.browser.ruleLimit') }}
    </p>
    <DesktopNetworkPermissionPreview v-if="showPreview" :settings="settings" :language="language" @close="showPreview = false" />
    <DesktopNetworkRuleDialog v-if="editor" :rule="editor.rule" :settings="settings" :language="language" :pending="busy" :save="save" @close="editor = null" />
  </section>
</template>

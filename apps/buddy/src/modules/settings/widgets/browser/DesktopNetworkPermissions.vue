<script setup lang="ts">
import type { NetworkOperation, NetworkPermissionDecision, NetworkPermissionRule, NetworkPermissions } from '@buddy-shared/permissions/networkPermissions'
import type { DataTableColumns, GlobalThemeOverrides } from 'naive-ui'
import type { DeepReadonly } from 'vue'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NETWORK_OPERATIONS, networkPermissionsSchema } from '@buddy-shared/permissions/networkPermissions'
import { Info20Regular } from '@vicons/fluent'
import { NButton, NDataTable, NEllipsis, NPopover } from 'naive-ui'
import { computed, h, shallowRef, useId } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'
import DesktopNetworkPermissionPreview from './DesktopNetworkPermissionPreview.vue'
import DesktopNetworkPermissionSelect from './DesktopNetworkPermissionSelect.vue'
import DesktopNetworkRuleActions from './DesktopNetworkRuleActions.vue'
import DesktopNetworkRuleDialog from './DesktopNetworkRuleDialog.vue'

interface NetworkPermissionRow {
  key: string
  rule: NetworkPermissionRule | null
  label: string
  decisions: NetworkPermissions['defaults']
}

const props = defineProps<{
  value: DeepReadonly<NetworkPermissions>
  language: BuddyLocale
  pending: boolean
  save: (settings: NetworkPermissions) => Promise<boolean>
}>()
const { t } = useBuddyI18n(() => props.language)
const tableId = useId()
const tableTheme: GlobalThemeOverrides['DataTable'] = {
  borderColor: 'var(--buddy-border-subtle)',
  borderRadius: '0',
  thColor: 'transparent',
  tdColor: 'transparent',
  tdColorHover: 'transparent',
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
const rows = computed<NetworkPermissionRow[]>(() => [
  { key: 'defaults', rule: null, label: t('desktop.browser.defaultPermissions'), decisions: settings.value.defaults },
  ...settings.value.rules.map(rule => ({ key: `rule-${rule.id}`, rule, label: rule.pattern, decisions: rule })),
])
const columnWidths = computed(() => ({ pattern: 184, permission: props.language === 'en-US' ? 208 : 144, actions: 88 }))
const scrollWidth = computed(() => columnWidths.value.pattern + columnWidths.value.permission * NETWORK_OPERATIONS.length + columnWidths.value.actions)
const columns = computed<DataTableColumns<NetworkPermissionRow>>(() => [
  {
    key: 'label',
    title: t('desktop.browser.domainPattern'),
    width: columnWidths.value.pattern,
    minWidth: columnWidths.value.pattern,
    cellProps: (_row, index) => ({ id: `${tableId}-row-${index}` }),
    render: row => [
      h(NEllipsis, { class: 'max-w-full align-middle' }, () => row.label),
      row.rule && row.rule.match !== 'exact'
        ? h('span', { class: 'mt-1 block text-[0.7rem] text-muted' }, t(`desktop.browser.match.${row.rule.match}`))
        : null,
    ],
  },
  ...NETWORK_OPERATIONS.map(operation => ({
    key: operation,
    title: () => h('span', { id: `${tableId}-${operation}` }, t(`desktop.browser.operation.${operation}`)),
    width: columnWidths.value.permission,
    minWidth: columnWidths.value.permission,
    render: (row: NetworkPermissionRow, index: number) => h(DesktopNetworkPermissionSelect, {
      language: props.language,
      labelledBy: `${tableId}-row-${index} ${tableId}-${operation}`,
      value: row.decisions[operation],
      disabled: busy.value,
      onChange: value => updatePermission(row.rule, operation, value),
    }),
  })),
  {
    key: 'actions',
    title: () => h('span', { class: 'sr-only' }, t('desktop.browser.ruleActions')),
    width: columnWidths.value.actions,
    minWidth: columnWidths.value.actions,
    render: (row) => {
      const rule = row.rule
      return rule
        ? h(DesktopNetworkRuleActions, {
            language: props.language,
            disabled: busy.value,
            options: ruleActions(rule.id),
            onAction: action => actOnRule(rule.id, action),
            onRemove: () => remove(rule.id),
          })
        : null
    },
  },
])

function rowKey(row: NetworkPermissionRow) {
  return row.key
}

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
  <section class="grid min-w-0 gap-3" :aria-labelledby="`${tableId}-heading`" data-testid="network-permissions">
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
      <NDataTable
        size="small"
        table-layout="fixed"
        :columns="columns"
        :data="rows"
        :row-key="rowKey"
        :scroll-x="scrollWidth"
        :bordered="false"
        :bottom-bordered="false"
        :theme-overrides="tableTheme"
      />
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

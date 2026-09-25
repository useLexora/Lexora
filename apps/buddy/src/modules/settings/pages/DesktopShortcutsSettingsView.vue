<script setup lang="ts">
import type { ShortcutEntry } from '@buddy-shared/shortcuts/keybinding'
import { conflictingShortcuts, formatKeybinding, keybindingFromInput } from '@buddy-shared/shortcuts/keybinding'
import { ArrowCounterclockwise20Regular, Edit20Regular } from '@vicons/fluent'
import { NButton, NInput, NModal, NTag, NTooltip, useMessage } from 'naive-ui'
import { computed, nextTick, shallowRef, useTemplateRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopSettingsPageLayout from '../layouts/DesktopSettingsPageLayout.vue'
import { useSettingsContext } from '../settingsContext'

const { applicationSettings, shortcuts } = useSettingsContext()
const { t } = useBuddyI18n(applicationSettings.language)
const message = useMessage()
const query = shallowRef('')
const editing = shallowRef<ShortcutEntry | null>(null)
const restoring = shallowRef<ShortcutEntry | null>(null)
const resetConfirming = shallowRef(false)
const candidate = shallowRef('')
const invalid = shallowRef(false)
const saving = shallowRef(false)
const recorder = useTemplateRef<InstanceType<typeof NInput>>('recorder')
const showEditor = computed({ get: () => !!editing.value, set: (value) => {
  if (!value)
    editing.value = null
} })
const showRestore = computed({ get: () => !!restoring.value, set: (value) => {
  if (!value)
    restoring.value = null
} })
const conflicts = computed(() => editing.value ? conflictingShortcuts(shortcuts.entries.value, editing.value.id, candidate.value, shortcuts.platform.value) : [])
const entries = computed(() => {
  const term = query.value.trim().toLocaleLowerCase().replaceAll(' ', '')
  return shortcuts.entries.value.filter(entry => [entry.label, entry.id, ...[entry.binding, ...entry.alternatives].map(binding => format(binding))].some(text => text.toLocaleLowerCase().replaceAll(' ', '').includes(term)))
})
const modified = computed(() => shortcuts.entries.value.some(entry => entry.modified))
function format(binding: string) {
  return formatKeybinding(binding, shortcuts.platform.value)
}
async function edit(entry: ShortcutEntry) {
  editing.value = entry
  candidate.value = entry.binding
  invalid.value = false
  await nextTick()
  recorder.value?.focus()
}
function capture(event: KeyboardEvent) {
  if (event.isComposing || event.key === 'Escape' || event.key === 'Tab')
    return
  event.preventDefault()
  event.stopPropagation()
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key))
    return
  const binding = keybindingFromInput(event, shortcuts.platform.value)
  invalid.value = binding === null
  if (binding !== null)
    candidate.value = binding
}
async function save(id: string, binding: string | null) {
  saving.value = true
  try {
    if (await shortcuts.set(id, binding))
      editing.value = null
    else
      message.error(t('desktop.shortcuts.saveFailed'))
  }
  finally {
    saving.value = false
  }
}
function updateCandidate(value: string) {
  candidate.value = value
  invalid.value = false
}
async function saveCandidate() {
  if (!editing.value)
    return
  await save(editing.value.id, candidate.value)
}
function confirmRestore(entry: ShortcutEntry) {
  restoring.value = entry
}
async function restoreShortcut() {
  if (!restoring.value)
    return
  saving.value = true
  try {
    if (await shortcuts.set(restoring.value.id, null))
      restoring.value = null
    else
      message.error(t('desktop.shortcuts.saveFailed'))
  }
  finally {
    saving.value = false
  }
}
async function resetAll() {
  saving.value = true
  try {
    if (await shortcuts.reset())
      resetConfirming.value = false
    else
      message.error(t('desktop.shortcuts.saveFailed'))
  }
  finally {
    saving.value = false
  }
}
function confirmReset() {
  resetConfirming.value = true
}
</script>

<template>
  <DesktopSettingsPageLayout :requires-runtime="false">
    <template #title>
      {{ t('desktop.settings.category.shortcuts') }}
    </template>
    <template #description>
      {{ t('desktop.settings.categoryDescription.shortcuts') }}
    </template>
    <template #actions>
      <NButton type="primary" size="small" :disabled="!modified || saving" @click="confirmReset">
        {{ t('desktop.shortcuts.resetAll') }}
      </NButton>
    </template>
    <div class="shortcut-settings" data-testid="shortcut-settings">
      <NInput v-model:value="query" clearable :placeholder="t('desktop.shortcuts.search')" />
      <div class="shortcut-settings__scroll">
        <table>
          <thead><tr><th>{{ t('desktop.shortcuts.command') }}</th><th>{{ t('desktop.shortcuts.binding') }}</th><th>{{ t('desktop.shortcuts.scope') }}</th><th>{{ t('desktop.shortcuts.actions') }}</th></tr></thead>
          <tbody>
            <tr v-for="entry in entries" :key="entry.id" :data-command-id="entry.id">
              <td>
                <div class="shortcut-settings__command">
                  <strong>{{ entry.label }}</strong>
                  <NTag v-if="entry.modified" size="small" type="info" :bordered="false">
                    {{ t('desktop.shortcuts.custom') }}
                  </NTag>
                </div>
              </td>
              <td>
                <div class="shortcut-settings__bindings">
                  <kbd v-for="binding in [entry.binding, ...entry.alternatives].filter(Boolean)" :key="binding">{{ format(binding) }}</kbd><span v-if="!entry.binding">{{ t('desktop.shortcuts.unassigned') }}</span>
                </div>
              </td>
              <td class="shortcut-settings__scope">
                {{ t(`desktop.shortcuts.scope.${entry.scope}`) }}
              </td>
              <td class="shortcut-settings__action">
                <div class="shortcut-settings__action-buttons">
                  <NTooltip>
                    <template #trigger>
                      <NButton class="buddy-icon-button" size="small" quaternary :disabled="saving" :aria-label="t('desktop.shortcuts.edit')" @click="edit(entry)">
                        <template #icon>
                          <DesktopIcon :component="Edit20Regular" :size="16" />
                        </template>
                      </NButton>
                    </template>
                    {{ t('desktop.shortcuts.edit') }}
                  </NTooltip>
                  <NTooltip v-if="entry.modified">
                    <template #trigger>
                      <NButton class="buddy-icon-button" size="small" quaternary :disabled="saving" :aria-label="t('desktop.shortcuts.restoreShortcut')" @click="confirmRestore(entry)">
                        <template #icon>
                          <DesktopIcon :component="ArrowCounterclockwise20Regular" :size="16" />
                        </template>
                      </NButton>
                    </template>
                    {{ t('desktop.shortcuts.restoreShortcut') }}
                  </NTooltip>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!entries.length" class="shortcut-settings__note">
        {{ t('desktop.shortcuts.noResults') }}
      </p>
    </div>
    <NModal v-model:show="resetConfirming" preset="dialog" type="warning" class="shortcut-reset-dialog" :title="t('desktop.shortcuts.resetAll')" :mask-closable="!saving" :close-on-esc="!saving" :closable="!saving">
      <p class="shortcut-dialog__description">
        {{ t('desktop.shortcuts.resetConfirm') }}
      </p>
      <template #action>
        <NButton :disabled="saving" @click="resetConfirming = false">
          {{ t('desktop.shortcuts.cancel') }}
        </NButton>
        <NButton type="primary" :loading="saving" @click="resetAll">
          {{ t('desktop.shortcuts.restore') }}
        </NButton>
      </template>
    </NModal>
    <NModal v-model:show="showRestore" preset="dialog" class="shortcut-restore-dialog" :title="t('desktop.shortcuts.restoreShortcut')" :mask-closable="!saving" :close-on-esc="!saving" :closable="!saving">
      <div v-if="restoring" class="shortcut-dialog__body">
        <p class="shortcut-dialog__description">
          {{ t('desktop.shortcuts.restoreShortcutConfirm', { name: restoring.label }) }}
        </p>
        <div class="shortcut-dialog__default">
          <span>{{ t('desktop.shortcuts.default') }}</span>
          <kbd v-if="restoring.defaultBinding">{{ format(restoring.defaultBinding) }}</kbd>
          <span v-else>{{ t('desktop.shortcuts.unassigned') }}</span>
        </div>
      </div>
      <template #action>
        <NButton :disabled="saving" @click="restoring = null">
          {{ t('desktop.shortcuts.cancel') }}
        </NButton>
        <NButton type="primary" :loading="saving" @click="restoreShortcut">
          {{ t('desktop.shortcuts.restore') }}
        </NButton>
      </template>
    </NModal>
    <NModal v-model:show="showEditor" preset="card" :title="editing?.label" class="shortcut-editor" :style="{ width: 'min(31rem, calc(100vw - 2rem))' }" :mask-closable="!saving" :close-on-esc="!saving" :closable="!saving">
      <div class="shortcut-editor__body">
        <p class="shortcut-dialog__description">
          {{ t('desktop.shortcuts.recordHint') }}
        </p>
        <NInput ref="recorder" :value="format(candidate)" readonly clearable :placeholder="t('desktop.shortcuts.pressKeys')" data-testid="shortcut-recorder" @keydown="capture" @update:value="updateCandidate" />
        <p v-if="invalid" class="shortcut-settings__error" role="alert">
          {{ t('desktop.shortcuts.invalid') }}
        </p>
        <p v-if="conflicts.length" class="shortcut-settings__error" role="alert">
          {{ t('desktop.shortcuts.conflict', { names: conflicts.map(entry => entry.label).join('、') }) }}
        </p>
      </div>
      <template #footer>
        <div class="shortcut-dialog__actions">
          <NButton :disabled="saving" @click="editing = null">
            {{ t('desktop.shortcuts.cancel') }}
          </NButton>
          <NButton type="primary" :loading="saving" :disabled="invalid || !!conflicts.length" @click="saveCandidate">
            {{ t('desktop.shortcuts.save') }}
          </NButton>
        </div>
      </template>
    </NModal>
  </DesktopSettingsPageLayout>
</template>

<style scoped>
.shortcut-settings { display: grid; min-width: 0; gap: 1rem; }
.shortcut-settings__scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; text-align: left; font-size: 0.8rem; }
th { color: var(--buddy-text-secondary); font-size: 0.75rem; font-weight: 500; }
th, td { border-bottom: 1px solid var(--buddy-border-subtle); padding: 0.8rem 0.5rem; }
th:first-child, td:first-child { padding-left: 0; }
td strong { display: block; font-weight: 500; }
.shortcut-settings__command { display: flex; flex-wrap: wrap; align-items: center; gap: 0.45rem; }
.shortcut-settings__command strong { display: inline; }
.shortcut-settings__bindings { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; }
kbd { padding: 0.2rem 0.4rem; border: 1px solid var(--buddy-border-subtle); border-radius: 4px; font-family: inherit; font-size: 0.75rem; white-space: nowrap; }
.shortcut-settings__scope { color: var(--buddy-text-secondary); white-space: nowrap; }
.shortcut-settings__action { width: 5rem; }
.shortcut-settings__action-buttons { display: flex; align-items: center; gap: 0.25rem; }
.shortcut-settings__note { margin: 0; color: var(--buddy-text-secondary); font-size: 0.75rem; line-height: 1.65; }
.shortcut-settings__error { color: var(--buddy-status-danger-text); font-size: 0.8rem; }
.shortcut-dialog__description { margin: 0; color: var(--buddy-text-secondary); font-size: 0.82rem; line-height: 1.6; }
.shortcut-dialog__actions { display: flex; justify-content: flex-end; gap: 0.6rem; }
.shortcut-dialog__body { display: grid; gap: 1rem; }
.shortcut-dialog__default { display: flex; align-items: center; justify-content: space-between; gap: 1rem; border: 1px solid var(--buddy-border-subtle); border-radius: 0.5rem; padding: 0.75rem; color: var(--buddy-text-secondary); font-size: 0.75rem; }
.shortcut-editor__body { display: grid; gap: 1rem; }
</style>

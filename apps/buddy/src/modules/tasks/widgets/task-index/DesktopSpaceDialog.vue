<script setup lang="ts">
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'

import type { SelectOption } from 'naive-ui'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type {
  TaskSpaceInput,
} from '@/modules/tasks/state/task-index/typing'
import { NAlert, NButton, NForm, NFormItem, NInput, NModal, NSelect } from 'naive-ui'
import { computed, h, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopSpaceAppearancePicker from '../space/DesktopSpaceAppearancePicker.vue'
import DesktopSpacePrimaryDirectoryField from './DesktopSpacePrimaryDirectoryField.vue'
import { useSpaceEditor } from './useSpaceEditor'

const props = defineProps<{
  language: BuddyLocale
  space: LocalSpace | null
  selectDirectory: () => Promise<string | null>
  save: (input: TaskSpaceInput) => Promise<boolean>
  show: boolean
}>()
const emit = defineEmits<{
  'update:show': [show: boolean]
}>()
const { t } = useBuddyI18n(() => props.language)
const appearanceOpen = shallowRef(false)
watch(() => props.show, () => {
  appearanceOpen.value = false
})
const { canSave, directoryChangeBlocked, directoryEditingDisabled, failed, form, save: confirm, saving, selectingDirectory, selectPrimaryDirectory } = useSpaceEditor({
  show: () => props.show,
  space: () => props.space,
  selectDirectory: () => props.selectDirectory(),
  save: input => props.save(input),
  onSaved: () => emit('update:show', false),
})
const memoryOptions = computed(() => [
  {
    description: t('desktop.tasks.spaceMemoryDefaultDescription'),
    label: t('desktop.tasks.spaceMemoryDefault'),
    value: 'personal_and_space',
  },
  {
    description: t('desktop.tasks.spaceMemoryIsolatedDescription'),
    label: t('desktop.tasks.spaceMemoryIsolated'),
    value: 'space_only',
  },
])
const dialogTitle = computed(() => props.space
  ? t('desktop.tasks.editSpaceTitle')
  : t('desktop.tasks.createSpaceTitle'))
function renderMemoryLabel(option: SelectOption, selected: boolean) {
  if (selected)
    return option.label as string
  return h('div', { class: 'desktop-space-dialog__memory-option' }, [
    h('strong', {}, option.label as string),
    h('small', {}, option.description as string),
  ])
}
</script>

<template>
  <NModal
    class="desktop-space-dialog"
    preset="card"
    :show="show"
    :style="{ width: 'min(34rem, calc(100vw - 2rem))' }"
    :title="dialogTitle"
    :close-on-esc="!appearanceOpen"
    @esc="appearanceOpen = false"
    @update:show="emit('update:show', $event)"
  >
    <NForm @submit.prevent="confirm">
      <NFormItem :label="t('desktop.tasks.spaceName')" required>
        <div class="flex w-full min-w-0 items-center gap-[8px]">
          <DesktopSpaceAppearancePicker
            v-model:show="appearanceOpen"
            v-model:icon="form.icon"
            v-model:icon-color="form.iconColor"
            :disabled="saving"
            :language="language"
          />
          <NInput
            v-model:value="form.name"
            :disabled="saving"
            autofocus
            maxlength="80"
            :placeholder="t('desktop.tasks.spaceNamePlaceholder')"
          />
        </div>
      </NFormItem>
      <NFormItem :label="t('desktop.tasks.spaceMemory')">
        <NSelect
          v-model:value="form.memoryScope"
          :disabled="saving"
          :consistent-menu-width="false"
          :options="memoryOptions"
          :render-label="renderMemoryLabel"
        />
      </NFormItem>
      <NFormItem :show-label="false">
        <DesktopSpacePrimaryDirectoryField
          :disabled="directoryEditingDisabled || saving || selectingDirectory"
          :language="language"
          :primary-directory="form.primaryDirectory"
          @remove-primary="form.primaryDirectory = null"
          @select-primary="selectPrimaryDirectory"
        />
      </NFormItem>
      <NAlert
        v-if="directoryChangeBlocked"
        :show-icon="false"
        type="warning"
      >
        {{ t('desktop.tasks.spaceActiveRunDirectoryWarning') }}
      </NAlert>
      <NAlert
        v-else-if="space && space.activeRunCount > 0"
        :show-icon="false"
        type="info"
      >
        {{ t('desktop.tasks.spaceActiveRunUpdateWarning') }}
      </NAlert>
      <NAlert v-if="failed" :show-icon="false" type="error">
        {{ t('desktop.command.failed') }}
      </NAlert>
    </NForm>
    <template #footer>
      <div class="flex justify-end gap-2">
        <NButton @click="emit('update:show', false)">
          {{ t('common.cancel') }}
        </NButton>
        <NButton
          type="primary"
          :disabled="!canSave"
          :loading="saving"
          @click="confirm"
        >
          {{ space ? t('common.save') : t('common.confirm') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
:global(.desktop-space-dialog__memory-option) {
  display: grid;
  min-width: 22rem;
  gap: 0.15rem;
  padding: 0.25rem 0;
}

:global(.desktop-space-dialog__memory-option strong) {
  font-weight: 600;
}

:global(.desktop-space-dialog__memory-option small) {
  color: var(--buddy-text-secondary);
  font-size: 0.7rem;
  white-space: normal;
}
</style>

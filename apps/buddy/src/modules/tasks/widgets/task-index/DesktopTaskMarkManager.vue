<script setup lang="ts">
import type { LocalTaskMark, TaskMarkInput } from '@buddy-shared/conversation/taskMarkApi'
import type { TaskMarks } from '../../contracts'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { SYSTEM_UNREAD_MARK_ID } from '@buddy-shared/conversation/taskMarkApi'
import { Add16Regular, ArrowLeft20Regular } from '@vicons/fluent'
import { NAlert, NButton, NModal, NSpin } from 'naive-ui'
import { computed, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopTaskMarkEditor from './DesktopTaskMarkEditor.vue'
import DesktopTaskMarkItem from './DesktopTaskMarkItem.vue'

type MarkDefinition = Pick<LocalTaskMark, 'id' | 'name' | 'description' | 'color'>

const props = defineProps<{ marks: TaskMarks, language: BuddyLocale }>()
const show = defineModel<boolean>('show', { required: true })
const { t } = useBuddyI18n(() => props.language)
const editing = shallowRef(false)
const initial = shallowRef<MarkDefinition | null>(null)
const deleteId = shallowRef<string | null>(null)
const session = shallowRef(0)
const readOnly = computed(() => initial.value?.id === SYSTEM_UNREAD_MARK_ID)
const definitions = computed<readonly MarkDefinition[]>(() => [{
  id: SYSTEM_UNREAD_MARK_ID,
  name: t('desktop.marks.unread'),
  description: t('desktop.marks.unreadDescription'),
  color: 'var(--buddy-accent-solid)',
}, ...props.marks.items.value])
const deletion = computed(() => props.marks.items.value.find(mark => mark.id === deleteId.value) ?? null)
const heading = computed(() => {
  if (!editing.value)
    return t('desktop.marks.manage')
  if (readOnly.value)
    return t('desktop.marks.details')
  return t(initial.value ? 'desktop.marks.edit' : 'desktop.marks.create')
})
watch(show, (open) => {
  session.value += 1
  editing.value = false
  initial.value = null
  deleteId.value = null
  if (open)
    void props.marks.refresh()
})

function edit(mark: MarkDefinition | null) {
  session.value += 1
  initial.value = mark
  editing.value = true
  deleteId.value = null
}

function backToList() {
  if (props.marks.busy.value)
    return
  session.value += 1
  editing.value = false
  initial.value = null
}

async function save(input: TaskMarkInput) {
  if (readOnly.value)
    return
  const version = session.value
  if (await props.marks.save(input, initial.value?.id) && session.value === version && show.value)
    editing.value = false
}

async function remove() {
  const id = deleteId.value
  if (id && await props.marks.remove(id) && deleteId.value === id)
    deleteId.value = null
}
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    class="desktop-task-mark-manager"
    :style="{ width: 'min(28rem, calc(100vw - 2rem))' }"
    :content-style="{ padding: editing ? '0 24px 20px' : '0 16px 16px' }"
    :closable="!marks.busy.value"
    :mask-closable="!marks.busy.value"
    :close-on-esc="!marks.busy.value"
  >
    <template #header>
      <div class="flex min-w-0 items-center justify-between gap-[12px] pr-[12px]">
        <div class="flex min-w-0 items-center gap-[8px]">
          <NButton v-if="editing" class="desktop-task-mark-manager__back" quaternary size="small" :disabled="marks.busy.value" :aria-label="t('desktop.marks.back')" @click="backToList">
            <template #icon>
              <DesktopIcon :component="ArrowLeft20Regular" :size="18" />
            </template>
          </NButton>
          <span class="text-[16px] font-600">{{ heading }}</span>
        </div>
        <NButton v-if="!editing" size="small" secondary :disabled="marks.busy.value || marks.loading.value" @click="edit(null)">
          <template #icon>
            <DesktopIcon :component="Add16Regular" :size="16" />
          </template>
          {{ t('desktop.marks.create') }}
        </NButton>
      </div>
    </template>
    <NAlert v-if="marks.error.value" type="error" :show-icon="false" class="desktop-task-mark-manager__error">
      {{ marks.error.value }}
      <NButton v-if="!editing" text @click="marks.refresh">
        {{ t('desktop.marks.retry') }}
      </NButton>
    </NAlert>
    <DesktopTaskMarkEditor v-if="editing" :key="session" :initial="initial" :readonly="readOnly" :busy="marks.busy.value" :language="language" @save="save" />
    <div v-else class="grid grid-cols-[minmax(0,_1fr)] gap-[12px]">
      <NSpin :show="marks.loading.value">
        <div class="grid min-w-0 max-h-[min(360px,_48vh)] grid-cols-[minmax(0,_1fr)] gap-[2px] overflow-y-auto">
          <DesktopTaskMarkItem
            v-for="mark in definitions"
            :key="mark.id"
            :mark="mark"
            :disabled="marks.busy.value"
            :language="language"
            @edit="edit(mark)"
            @remove="deleteId = mark.id"
          />
        </div>
      </NSpin>
      <NAlert v-if="deletion" type="warning" :show-icon="false" class="desktop-task-mark-manager__deletion">
        <p>{{ t('desktop.marks.deleteMessage', { name: deletion.name }) }}</p>
        <div class="flex justify-end gap-[8px]">
          <NButton size="small" :disabled="marks.busy.value" @click="deleteId = null">
            {{ t('common.cancel') }}
          </NButton>
          <NButton size="small" type="error" :loading="marks.busy.value" :disabled="marks.busy.value" @click="remove">
            {{ t('desktop.marks.confirmDelete') }}
          </NButton>
        </div>
      </NAlert>
    </div>
  </NModal>
</template>

<style scoped lang="scss">
.desktop-task-mark-manager__back {
  width: 28px;
  height: 28px;
  padding: 0;
  margin-left: -6px;
}

.desktop-task-mark-manager__error {
  margin-bottom: 12px;
}

.desktop-task-mark-manager__deletion p {
  margin: 0 0 12px;
}
</style>

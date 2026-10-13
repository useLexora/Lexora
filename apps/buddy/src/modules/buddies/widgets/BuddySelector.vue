<script setup lang="ts">
import type { Ref } from 'vue'
import { Add16Regular, ChevronLeft16Regular, Search16Regular } from '@vicons/fluent'
import { NBadge, NButton, NInput, NPopover } from 'naive-ui'
import { computed, nextTick, shallowRef, useTemplateRef } from 'vue'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useBuddiesContext } from '../buddiesContext'
import { buddyLabels } from '../buddyLabels'
import BuddyAvatar from './BuddyAvatar.vue'
import BuddyIcon from './BuddyIcon.vue'
import BuddyTaskMember from './BuddyTaskMember.vue'

const props = defineProps<{
  activity?: { count: number, label: string, byBuddy: ReadonlyMap<string, 'working' | 'waiting'> }
  buddyId: string | null
  disabled: boolean
  select: (id: string) => Promise<boolean>
  members: {
    memberIds: Readonly<Ref<readonly string[]>>
    busy: Readonly<Ref<boolean>>
    error: Readonly<Ref<string>>
    refresh: () => Promise<void>
    add: (id: string) => Promise<boolean>
    remove: (id: string) => Promise<boolean>
  }
}>()
const { buddies, ready, failed, refresh } = useBuddiesContext()
const { language } = useDesktopUi()
const labels = computed(() => buddyLabels(language.value))
const open = shallowRef(false)
const adding = shallowRef(false)
const query = shallowRef('')
const searchOpen = shallowRef(false)
const searchInput = useTemplateRef<InstanceType<typeof NInput>>('searchInput')
const searchButton = useTemplateRef<InstanceType<typeof NButton>>('searchButton')
const addButton = useTemplateRef<InstanceType<typeof NButton>>('addButton')
const backButton = useTemplateRef<InstanceType<typeof NButton>>('backButton')
const selecting = shallowRef(false)
const memberIds = computed(() => [...new Set([...props.members.memberIds.value, ...(props.activity?.byBuddy.keys() ?? [])])].sort((a, b) => Number(b === props.buddyId) - Number(a === props.buddyId)))
const busy = computed(() => props.disabled || props.members.busy.value || selecting.value)
const candidates = computed(() => buddies.value.filter(buddy => buddy.kind === 'actor' && buddy.enabled && !buddy.deletedAt
  && !props.members.memberIds.value.includes(buddy.id) && buddy.name.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())))

async function choose(id: string) {
  if (busy.value)
    return
  selecting.value = true
  try {
    await props.select(id)
  }
  finally {
    selecting.value = false
  }
}
function show(value: boolean) {
  adding.value = false
  query.value = ''
  searchOpen.value = false
  if (value) {
    void refresh()
    void props.members.refresh()
  }
}

async function startAdding() {
  adding.value = true
  await nextTick()
  backButton.value?.$el.focus()
}

async function returnToMembers() {
  adding.value = false
  query.value = ''
  searchOpen.value = false
  await nextTick()
  addButton.value?.$el.focus()
}

async function expandSearch() {
  searchOpen.value = true
  await nextTick()
  searchInput.value?.focus()
}

async function closeSearch() {
  query.value = ''
  searchOpen.value = false
  await nextTick()
  searchButton.value?.$el.focus()
}
</script>

<template>
  <NPopover v-model:show="open" trigger="click" placement="bottom-end" :animated="false" :show-arrow="false" :style="{ padding: 0 }" @update:show="show">
    <template #trigger>
      <NBadge class="buddy-partner-badge" :show="(activity?.count ?? 0) > 0" :value="`+${activity?.count ?? 0}`" color="var(--buddy-accent-solid)" :theme-overrides="{ fontSize: '10px' }">
        <NButton class="buddy-icon-button" quaternary :theme-overrides="{ heightMedium: '2rem' }" :aria-label="activity?.label || labels.title" :aria-expanded="open" :disabled="!ready || disabled" data-testid="conversation-buddy-toggle" @keydown.esc.stop="open = false">
          <template #icon>
            <DesktopIcon :size="18" :class="{ 'text-accent-on-surface': (activity?.count ?? 0) > 0 }">
              <BuddyIcon variant="toolbar" />
            </DesktopIcon>
          </template>
        </NButton>
      </NBadge>
    </template>
    <div class="w-[312px] max-w-[calc(100vw-32px)]" data-testid="conversation-buddy-picker" @keydown.esc.stop="open = false">
      <header class="box-border flex h-11 items-center gap-2 px-3 border-b-1 border-b-solid border-b-border">
        <div class="flex min-w-0 flex-1 items-center gap-1">
          <NButton v-if="adding" ref="backButton" size="small" quaternary class="buddy-icon-button text-muted" :theme-overrides="{ heightSmall: '24px' }" :aria-label="labels.back" @click="returnToMembers">
            <template #icon>
              <DesktopIcon :component="ChevronLeft16Regular" :size="16" />
            </template>
          </NButton>
          <strong class="truncate text-[13px] font-500 leading-5 text-fg">{{ adding ? labels.add : labels.title }}</strong>
        </div>
        <NInput v-if="adding && (searchOpen || query)" ref="searchInput" v-model:value="query" class="buddy-selector-search min-w-0 flex-none" size="small" :placeholder="labels.searchPlaceholder" :input-props="{ 'aria-label': labels.searchCompanions }" clearable @blur="searchOpen = false" @keydown.esc.stop="closeSearch">
          <template #prefix>
            <DesktopIcon :component="Search16Regular" :size="16" class="text-muted" />
          </template>
        </NInput>
        <NButton v-else-if="adding" ref="searchButton" size="small" quaternary class="buddy-icon-button text-muted" :aria-label="labels.searchCompanions" @click="expandSearch">
          <template #icon>
            <DesktopIcon :component="Search16Regular" :size="16" />
          </template>
        </NButton>
        <NButton v-else ref="addButton" size="small" quaternary :theme-overrides="{ heightSmall: '28px', fontSizeSmall: '12px' }" :disabled="busy" @click="startAdding">
          <template #icon>
            <DesktopIcon :component="Add16Regular" :size="16" />
          </template>
          <span class="leading-none">{{ labels.add }}</span>
        </NButton>
      </header>
      <p v-if="members.error.value || failed" role="alert" class="m-0 px-3 pt-2 text-[12px] text-danger">
        {{ members.error.value || labels.listFailed }}
        <NButton text @click="refresh(); members.refresh()">
          {{ labels.retry }}
        </NButton>
      </p>
      <template v-if="adding">
        <div class="max-h-[280px] overflow-y-auto p-1" data-testid="conversation-buddy-candidates">
          <button v-for="buddy in candidates" :key="buddy.id" type="button" :data-actor-id="buddy.id" :disabled="busy" class="ui-focus-ring flex w-full items-center gap-3 rounded-[6px] border-0 px-3 py-2 text-left bg-transparent text-fg cursor-pointer hover:bg-nav-hover disabled:cursor-default" @click="members.add(buddy.id)">
            <BuddyAvatar :buddy-id="buddy.id" :src="buddy.avatar" class="size-8 shrink-0" />
            <span class="min-w-0 flex-1 truncate text-[13px]">{{ buddy.name }}</span>
            <DesktopIcon :component="Add16Regular" :size="16" class="text-muted" />
          </button>
          <p v-if="!candidates.length" class="m-0 px-3 py-5 text-[12px] text-muted">
            {{ query.trim() ? labels.noMatchingCompanions : labels.noCandidates }}
          </p>
        </div>
      </template>
      <template v-else>
        <div class="max-h-[300px] overflow-y-auto py-1" :aria-label="labels.members">
          <BuddyTaskMember v-for="id in memberIds" :key="id" :buddy-id="id" :leader="id === buddyId" :activity="activity?.byBuddy.get(id)" :removed="!members.memberIds.value.includes(id)" :disabled="busy" @select="choose(id)" @remove="members.remove(id)">
            <template #actions>
              <slot name="member-actions" :buddy-id="id" />
            </template>
            <template #activity>
              <slot name="member-activity" :buddy-id="id" />
            </template>
          </BuddyTaskMember>
        </div>
        <p class="m-0 px-3 py-2.5 text-[12px] text-muted border-t-1 border-t-solid border-t-border">
          {{ labels.nextTurnOnly }}
        </p>
      </template>
    </div>
  </NPopover>
</template>

<style scoped lang="scss">
.buddy-partner-badge :deep(.n-badge-sup) {
  top: auto;
  right: 0;
  bottom: 0;
  left: auto;
  box-sizing: border-box;
  justify-content: center;
  height: 14px;
  min-width: 16px;
  padding: 0 3px;
  line-height: 14px;
  transform: translate(0, -10%);
}

.buddy-selector-search.n-input {
  width: 9rem;
}
</style>

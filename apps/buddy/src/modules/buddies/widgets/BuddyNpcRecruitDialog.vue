<script setup lang="ts">
import type { LocalBuddy } from '@buddy-shared/buddies/buddyApi'
import {
  CheckmarkCircle20Filled,
  Dismiss20Regular,
  Search20Regular,
  Sparkle20Regular,
} from '@vicons/fluent'
import {
  NButton,
  NInput,
  NModal,
  NScrollbar,
  NTag,
} from 'naive-ui'
import { computed, ref, shallowRef, watch } from 'vue'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { buddyLabels } from '../buddyLabels'
import BuddyAvatar from './BuddyAvatar.vue'

const props = defineProps<{
  show: boolean
  buddies: readonly LocalBuddy[]
  selectedIds: readonly string[]
  disabled: boolean
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  'save': [selectedIds: string[]]
}>()

const { language } = useDesktopUi()
const labels = computed(() => buddyLabels(language.value))
const searchQuery = shallowRef('')
const draftSelection = ref<Set<string>>(new Set())

watch(() => props.show, (open) => {
  if (open) {
    draftSelection.value = new Set(props.selectedIds)
    searchQuery.value = ''
  }
})

const candidates = computed(() =>
  props.buddies.filter(b => b.kind === 'npc' && !b.deletedAt),
)

const filteredCandidates = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query)
    return candidates.value
  return candidates.value.filter(b =>
    b.name.toLowerCase().includes(query) || (b.description && b.description.toLowerCase().includes(query)),
  )
})

function toggleNpc(id: string) {
  if (props.disabled)
    return
  const next = new Set(draftSelection.value)
  if (next.has(id))
    next.delete(id)
  else
    next.add(id)
  draftSelection.value = next
}

function selectAll() {
  draftSelection.value = new Set(candidates.value.map(c => c.id))
}

function clearAll() {
  draftSelection.value = new Set()
}

function confirm() {
  emit('save', [...draftSelection.value])
  emit('update:show', false)
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    :bordered="false"
    :mask-closable="!disabled"
    :close-on-esc="!disabled"
    :closable="!disabled"
    class="w-[min(760px,calc(100vw-32px))] buddy-recruit-dialog"
    @update:show="emit('update:show', $event)"
  >
    <template #header>
      <div class="flex items-center gap-2">
        <DesktopIcon :component="Sparkle20Regular" class="text-accent-text text-[18px]" />
        <span class="text-[15px] font-600 text-fg">{{ labels.recruitNpc }}</span>
      </div>
    </template>

    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-3">
        <NInput
          v-model:value="searchQuery"
          size="small"
          class="flex-1"
          clearable
          :placeholder="labels.searchCompanions"
        >
          <template #prefix>
            <DesktopIcon :component="Search20Regular" class="text-muted" />
          </template>
        </NInput>
        <div class="flex shrink-0 items-center gap-2">
          <NButton size="small" quaternary :disabled="disabled" @click="selectAll">
            {{ labels.selectAll }}
          </NButton>
          <NButton size="small" quaternary :disabled="disabled" @click="clearAll">
            {{ labels.deselectAll }}
          </NButton>
        </div>
      </div>

      <NScrollbar class="max-h-[min(56vh,500px)]">
        <div class="p-2.5">
          <div class="grid grid-cols-2 gap-3.5">
            <div
              v-for="npc in filteredCandidates"
              :key="npc.id"
              class="npc-recruit-card relative flex flex-col justify-between rounded-[0.65rem] border border-solid p-3.5 select-none cursor-pointer transition-all duration-150"
              :class="draftSelection.has(npc.id) ? 'is-selected' : 'is-unselected'"
              @click="toggleNpc(npc.id)"
            >
              <div v-if="draftSelection.has(npc.id)" class="recruit-stamp">
                <span class="recruit-stamp__text">RECRUITED</span>
              </div>

              <div>
                <div class="flex items-start gap-3">
                  <BuddyAvatar :buddy-id="npc.id" :src="npc.avatar" class="size-11 rounded-full shadow-sm" />
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-1.5 flex-wrap">
                      <strong class="text-[14px] font-600 text-fg truncate max-w-[140px]">{{ npc.name }}</strong>
                      <NTag v-if="!npc.enabled" size="tiny" :bordered="false" class="text-muted">
                        {{ labels.paused }}
                      </NTag>
                    </div>
                    <div class="mt-1 flex items-center gap-1.5 flex-wrap">
                      <NTag size="tiny" :bordered="false" class="uppercase text-[10px]">
                        {{ npc.settings.model ? npc.settings.model.modelId : '默认模型' }}
                      </NTag>
                      <span v-if="npc.settings.tools.mode === 'selected'" class="text-[11px] text-muted">
                        {{ npc.settings.tools.ids.length }} 工具
                      </span>
                    </div>
                  </div>
                </div>

                <p class="m-0 mt-2.5 text-[12px] text-muted leading-relaxed line-clamp-2">
                  {{ npc.description || labels.noDescription }}
                </p>
              </div>

              <div class="mt-3.5 pt-2.5 border-t border-t-solid border-t-border/50 flex items-center justify-between">
                <span class="text-[11px] font-mono text-muted uppercase">
                  ID: {{ npc.id.slice(0, 8) }}
                </span>

                <div class="flex items-center gap-1 text-[12px] font-500">
                  <template v-if="draftSelection.has(npc.id)">
                    <DesktopIcon :component="CheckmarkCircle20Filled" class="text-accent-text text-[15px]" />
                    <span class="text-accent-text font-600">已入队</span>
                  </template>
                  <template v-else>
                    <span class="text-muted group-hover:text-fg transition-colors">+ 招募入队</span>
                  </template>
                </div>
              </div>
            </div>
          </div>

          <div v-if="!filteredCandidates.length" class="py-12 text-center text-[13px] text-muted">
            {{ labels.noCandidates }}
          </div>
        </div>
      </NScrollbar>
    </div>

    <template #action>
      <div class="flex items-center justify-between w-full">
        <div class="flex items-center gap-2">
          <span class="text-[13px] font-500 text-fg">
            已编入小队：<span class="tabular-nums font-600 text-accent-text">{{ draftSelection.size }}</span> 位
          </span>
        </div>
        <div class="flex items-center gap-2">
          <NButton size="small" :disabled="disabled" @click="emit('update:show', false)">
            <template #icon>
              <DesktopIcon :component="Dismiss20Regular" />
            </template>
            {{ labels.cancel }}
          </NButton>
          <NButton size="small" type="primary" :disabled="disabled" @click="confirm">
            <template #icon>
              <DesktopIcon :component="Sparkle20Regular" />
            </template>
            确认编队
          </NButton>
        </div>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.buddy-recruit-dialog {
  :deep(.n-card-header) {
    padding: 16px 20px 12px;
  }
  :deep(.n-card__content) {
    padding: 0 20px 14px;
  }
  :deep(.n-card__action) {
    padding: 12px 20px;
  }
}

.npc-recruit-card {
  background: var(--buddy-surface-base);
  border: 1px solid var(--buddy-border-subtle);
  box-sizing: border-box;

  &:hover {
    border-color: var(--buddy-border-strong);
  }

  &.is-selected {
    border-color: var(--buddy-accent-border);
    box-shadow: 0 0 0 1px var(--buddy-accent-border), var(--buddy-shadow-soft);
    background: linear-gradient(
      145deg,
      var(--buddy-surface-base) 65%,
      var(--buddy-accent-surface-subtle) 100%
    );
  }
}

.recruit-stamp {
  position: absolute;
  top: 10px;
  right: 10px;
  pointer-events: none;
  border: 1.5px solid var(--buddy-accent-border);
  border-radius: 4px;
  padding: 1px 6px;
  transform: rotate(-7deg);
  opacity: 0.95;
  background: var(--buddy-accent-surface-subtle);
  box-shadow: var(--buddy-shadow-soft);
  animation: stamp-pop 0.18s cubic-bezier(0.175, 0.885, 0.32, 1.275);
}

.recruit-stamp__text {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: var(--buddy-accent-text);
  text-transform: uppercase;
}

@keyframes stamp-pop {
  0% {
    transform: scale(1.3) rotate(-14deg);
    opacity: 0;
  }
  100% {
    transform: scale(1) rotate(-7deg);
    opacity: 0.95;
  }
}
</style>

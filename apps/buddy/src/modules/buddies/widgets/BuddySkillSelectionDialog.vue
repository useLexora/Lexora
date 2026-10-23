<script setup lang="ts">
import type { LocalSkill } from '@buddy-shared/skills/skillApi'
import { skillInvocationName } from '@buddy-shared/skills/skillApi'
import {
  Flash20Filled,
  Flash20Regular,
  Search20Regular,
} from '@vicons/fluent'
import {
  NButton,
  NCheckbox,
  NInput,
  NModal,
  NScrollbar,
  NTag,
  NTooltip,
} from 'naive-ui'
import { computed, ref, shallowRef, watch } from 'vue'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { buddyLabels } from '../buddyLabels'

const props = defineProps<{
  show: boolean
  skillCatalog: readonly LocalSkill[]
  selectedSkillIds: readonly string[]
  requiredSkillIds: readonly string[]
  disabled: boolean
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  'save': [selectedSkillIds: string[], requiredSkillIds: string[]]
}>()

const { language } = useDesktopUi()
const labels = computed(() => buddyLabels(language.value))
const searchQuery = shallowRef('')
const draftSelected = ref<Set<string>>(new Set())
const draftRequired = ref<Set<string>>(new Set())

watch(() => props.show, (open) => {
  if (open) {
    draftSelected.value = new Set(props.selectedSkillIds)
    draftRequired.value = new Set(props.requiredSkillIds)
    searchQuery.value = ''
  }
})

const filteredSkills = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query)
    return props.skillCatalog
  return props.skillCatalog.filter(skill =>
    [skillInvocationName(skill), skill.description, skill.plugin?.extensionName, skill.plugin?.extensionId].some(value => value?.toLowerCase().includes(query)),
  )
})

function toggleSkill(id: string) {
  if (props.disabled)
    return
  const nextSelected = new Set(draftSelected.value)
  const nextRequired = new Set(draftRequired.value)

  if (nextSelected.has(id)) {
    nextSelected.delete(id)
    nextRequired.delete(id)
  }
  else {
    nextSelected.add(id)
  }

  draftSelected.value = nextSelected
  draftRequired.value = nextRequired
}

function toggleRequired(id: string) {
  if (props.disabled || !draftSelected.value.has(id))
    return
  const nextRequired = new Set(draftRequired.value)
  if (nextRequired.has(id))
    nextRequired.delete(id)
  else
    nextRequired.add(id)
  draftRequired.value = nextRequired
}

function selectAll() {
  draftSelected.value = new Set(props.skillCatalog.map(s => s.id))
}

function deselectAll() {
  draftSelected.value = new Set()
  draftRequired.value = new Set()
}

function confirm() {
  emit('save', [...draftSelected.value], [...draftRequired.value])
  emit('update:show', false)
}

function scopeLabel(source: LocalSkill['source']) {
  if (source === 'directory')
    return labels.value.scopeDirectory
  if (source === 'space')
    return labels.value.scopeSpace
  return labels.value.scopeGlobal
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    :title="labels.configureSkills"
    :bordered="false"
    :mask-closable="!disabled"
    :close-on-esc="!disabled"
    :closable="!disabled"
    class="w-[min(680px,calc(100vw-32px))] buddy-skill-dialog"
    @update:show="emit('update:show', $event)"
  >
    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-3">
        <NInput
          v-model:value="searchQuery"
          size="small"
          class="flex-1"
          clearable
          :placeholder="labels.searchSkills"
        >
          <template #prefix>
            <DesktopIcon :component="Search20Regular" class="text-muted" />
          </template>
        </NInput>
        <div class="flex shrink-0 items-center gap-2">
          <NButton size="small" quaternary :disabled="disabled" @click="selectAll">
            {{ labels.selectAll }}
          </NButton>
          <NButton size="small" quaternary :disabled="disabled" @click="deselectAll">
            {{ labels.deselectAll }}
          </NButton>
        </div>
      </div>

      <NScrollbar class="max-h-[min(56vh,480px)] pr-2">
        <div class="pt-1.5 px-1 pb-2">
          <div class="flex flex-col divide-y divide-border rounded-[0.5rem] border border-solid border-border overflow-hidden bg-surface">
            <div
              v-for="skill in filteredSkills"
              :key="skill.id"
              class="flex items-center justify-between gap-3 px-3.5 py-3 transition-colors hover:bg-hover select-none cursor-pointer"
              @click="toggleSkill(skill.id)"
            >
              <div class="flex items-start gap-3 min-w-0 flex-1">
                <NCheckbox
                  :checked="draftSelected.has(skill.id)"
                  :disabled="disabled || skill.status !== 'available'"
                  class="mt-0.5"
                  @click.stop
                  @update:checked="toggleSkill(skill.id)"
                />
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="truncate text-[13px] font-600 text-fg">{{ skillInvocationName(skill) }}</span>
                    <NTag size="tiny" :bordered="false" class="shrink-0">
                      {{ skill.plugin?.extensionName ?? scopeLabel(skill.source) }}
                    </NTag>
                    <span v-if="skill.status !== 'available'" class="text-[11px] text-muted">
                      {{ labels.unavailableChoice }}
                    </span>
                  </div>
                  <p v-if="skill.plugin" class="m-0 mt-1 text-[11px] text-muted [overflow-wrap:anywhere]">
                    {{ skill.plugin.extensionId }}
                  </p>
                  <p v-if="skill.description" class="m-0 mt-1 text-[12px] text-muted line-clamp-2 leading-relaxed">
                    {{ skill.description }}
                  </p>
                </div>
              </div>

              <div class="flex items-center gap-2 shrink-0" @click.stop>
                <NTooltip trigger="hover">
                  <template #trigger>
                    <NButton
                      size="small"
                      :secondary="draftRequired.has(skill.id)"
                      :quaternary="!draftRequired.has(skill.id)"
                      :type="draftRequired.has(skill.id) ? 'primary' : 'default'"
                      :disabled="disabled || !draftSelected.has(skill.id) || skill.status !== 'available'"
                      @click="toggleRequired(skill.id)"
                    >
                      <template #icon>
                        <DesktopIcon :component="draftRequired.has(skill.id) ? Flash20Filled : Flash20Regular" />
                      </template>
                      {{ labels.preloaded }}
                    </NButton>
                  </template>
                  {{ labels.preloadSkillHint }}
                </NTooltip>
              </div>
            </div>

            <div v-if="!filteredSkills.length" class="py-8 text-center text-[13px] text-muted">
              {{ labels.unavailableChoice }}
            </div>
          </div>
        </div>
      </NScrollbar>
    </div>

    <template #action>
      <div class="flex items-center justify-between w-full">
        <span class="text-[12px] text-muted">
          {{ labels.skillsCount(draftSelected.size, draftRequired.size) }}
        </span>
        <div class="flex items-center gap-2">
          <NButton size="small" :disabled="disabled" @click="emit('update:show', false)">
            {{ labels.cancel }}
          </NButton>
          <NButton size="small" type="primary" :disabled="disabled" @click="confirm">
            {{ labels.confirm }}
          </NButton>
        </div>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.buddy-skill-dialog {
  :deep(.n-card-header) {
    padding: 16px 20px 12px;
  }
  :deep(.n-card__content) {
    padding: 0 20px 16px;
  }
  :deep(.n-card__action) {
    padding: 12px 20px;
  }
}
</style>

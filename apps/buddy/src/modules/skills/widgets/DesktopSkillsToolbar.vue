<script setup lang="ts">
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Search20Regular } from '@vicons/fluent'
import { NButton, NInput, NSelect } from 'naive-ui'
import { computed, nextTick, shallowRef, useTemplateRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  language: BuddyLocale
  category: 'global' | 'space'
  spaceId: string | null
  spaces: readonly LocalSpace[]
  disabled: boolean
}>()
const emit = defineEmits<{ category: [value: 'global' | 'space'], space: [id: string], install: [], create: [] }>()
const search = defineModel<string>('search', { required: true })
const { t } = useBuddyI18n(() => props.language)
const spaceOptions = computed(() => props.spaces.filter(space => !space.revokedAt).map(space => ({ value: space.id, label: space.name })))
const hasScope = computed(() => props.category === 'global' || !!props.spaceId)
const searchOpen = shallowRef(false)
const searchInput = useTemplateRef<InstanceType<typeof NInput>>('searchInput')
const searchButton = useTemplateRef<InstanceType<typeof NButton>>('searchButton')

async function expandSearch() {
  searchOpen.value = true
  await nextTick()
  searchInput.value?.focus()
}

async function closeSearch() {
  search.value = ''
  searchOpen.value = false
  await nextTick()
  searchButton.value?.$el.focus()
}
</script>

<template>
  <div class="skills-toolbar">
    <div class="skills-toolbar__primary">
      <div class="skills-toolbar__category" role="group" :aria-label="t('desktop.skills.scope')">
        <button type="button" :class="{ 'is-active': category === 'global' }" :aria-pressed="category === 'global'" :disabled="disabled" @click="emit('category', 'global')">
          {{ t('skill.source.global') }}
        </button>
        <button type="button" :class="{ 'is-active': category === 'space' }" :aria-pressed="category === 'space'" :disabled="disabled" @click="emit('category', 'space')">
          {{ t('desktop.skills.spaces') }}
        </button>
      </div>
      <NSelect v-if="category === 'space'" class="skills-toolbar__space" :value="spaceId" :options="spaceOptions" filterable :disabled="disabled" :aria-label="t('desktop.skills.selectSpace')" :placeholder="t('desktop.skills.selectSpace')" @update:value="emit('space', $event)" />
    </div>
    <div class="skills-toolbar__actions">
      <NInput v-if="hasScope && (searchOpen || search)" ref="searchInput" v-model:value="search" class="skills-toolbar__search" clearable :placeholder="t('desktop.skills.search')" :aria-label="t('desktop.skills.searchAction')" @blur="searchOpen = false" @keydown.esc.stop="closeSearch">
        <template #prefix>
          <DesktopIcon :component="Search20Regular" :size="16" />
        </template>
      </NInput>
      <NButton v-else-if="hasScope" ref="searchButton" class="skills-toolbar__search-button" quaternary :aria-label="t('desktop.skills.searchAction')" @click="expandSearch">
        <template #icon>
          <DesktopIcon :component="Search20Regular" />
        </template>
      </NButton>
      <NButton :disabled="disabled || !hasScope" @click="emit('install')">
        {{ t('desktop.skills.install') }}
      </NButton>
      <NButton type="primary" :disabled="disabled || !hasScope" @click="emit('create')">
        {{ t('desktop.skills.create') }}
      </NButton>
    </div>
  </div>
</template>

<style scoped>
.skills-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem 1rem; }
.skills-toolbar__primary { display: flex; flex: 1 1 auto; min-width: 0; align-items: center; gap: 0.75rem; }
.skills-toolbar__category { display: flex; flex: none; align-items: center; gap: 2px; border-radius: 9px; background: var(--buddy-surface-subtle); padding: 3px; }
.skills-toolbar__category button { border: 0; border-radius: 7px; padding: 9px 14px; background: transparent; color: var(--buddy-text-secondary); font: inherit; font-size: 13px; font-weight: 580; line-height: 1; cursor: pointer; }
.skills-toolbar__category button:hover { color: var(--buddy-text-strong); }
.skills-toolbar__category button:focus-visible { outline: 2px solid var(--buddy-focus-ring); outline-offset: 1px; }
.skills-toolbar__category button.is-active { background: var(--buddy-surface-base); box-shadow: var(--buddy-shadow-soft); color: var(--buddy-text-strong); }
.skills-toolbar__category button:disabled { cursor: default; opacity: 0.5; }
.skills-toolbar__space { width: clamp(9rem, 18vw, 14rem); min-width: 0; }
.skills-toolbar__actions { display: flex; flex: 0 1 auto; min-width: 0; align-items: center; justify-content: flex-end; gap: 0.5rem; margin-left: auto; }
.skills-toolbar__search { width: clamp(12rem, 18vw, 18rem); }
</style>

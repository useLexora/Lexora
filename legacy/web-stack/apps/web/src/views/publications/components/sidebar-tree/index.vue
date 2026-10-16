<script setup lang="ts">
import type { PublicationSidebarTreeProps } from './typing'
import { computed, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { SvgIcon } from '@/components/svg-icon'
import PublicationSidebarPageNode from '../sidebar-page-node'

const props = defineProps<PublicationSidebarTreeProps>()
const { t } = useI18n()
const expandedByGroupId = reactive<Record<string, boolean>>({})

const visibleGroups = computed(() => props.groups.filter(group => group.pages.length))

watch(
  visibleGroups,
  (groups) => {
    for (const group of groups) {
      expandedByGroupId[group.id] ??= !group.collapsed
    }
  },
  { immediate: true },
)

function toggleGroup(groupId: string) {
  expandedByGroupId[groupId] = !expandedByGroupId[groupId]
}
</script>

<template>
  <nav class="publication-sidebar-tree" :aria-label="t('docs.publicReader.siteSidebar')">
    <section
      v-for="group in visibleGroups"
      :id="`publication-section-${group.id}`"
      :key="group.id"
      class="publication-sidebar-tree__group"
    >
      <button
        class="publication-sidebar-tree__group-trigger"
        type="button"
        @click="toggleGroup(group.id)"
      >
        <span class="publication-sidebar-tree__group-title">{{ group.title }}</span>
        <SvgIcon
          category="ui"
          :icon="expandedByGroupId[group.id] ? 'chevron-down' : 'chevron-right'"
          size="12px"
        />
      </button>

      <ul v-show="expandedByGroupId[group.id]" class="publication-sidebar-tree__pages">
        <PublicationSidebarPageNode
          v-for="page in group.pages"
          :key="page.id"
          :page="page"
          :site-id="props.siteId"
          :active-document-id="props.activeDocumentId"
        />
      </ul>
    </section>
  </nav>
</template>

<style scoped lang="scss">
.publication-sidebar-tree {
  display: grid;
  gap: 0;
}

.publication-sidebar-tree__group {
  min-width: 0;
  padding-bottom: 0.5rem;

  & + & {
    border-top: 1px solid var(--publication-c-divider);
    padding-top: 0.625rem;
  }
}

.publication-sidebar-tree__group-trigger {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.25rem 0;
  border: 0;
  background: transparent;
  color: var(--publication-c-text-1);
  cursor: pointer;
  font: inherit;
  text-align: left;

  &:hover,
  &:focus-visible {
    color: var(--publication-c-brand-1);
  }
}

.publication-sidebar-tree__group-title {
  min-width: 0;
  overflow: hidden;
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.5rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.publication-sidebar-tree__pages {
  display: grid;
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}
</style>

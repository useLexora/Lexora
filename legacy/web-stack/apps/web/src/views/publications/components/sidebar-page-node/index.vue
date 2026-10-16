<script setup lang="ts">
import type { PublicationSidebarPageNodeProps } from './typing'

defineOptions({
  name: 'PublicationSidebarPageNode',
})

const props = defineProps<PublicationSidebarPageNodeProps>()
</script>

<template>
  <li class="publication-sidebar-page-node">
    <RouterLink
      class="publication-sidebar-page-node__link"
      :class="{ 'is-active': props.page.documentId === props.activeDocumentId }"
      :to="`/s/${props.siteId}/${props.page.documentId}`"
    >
      {{ props.page.title }}
    </RouterLink>

    <ul v-if="props.page.children.length" class="publication-sidebar-page-node__children">
      <PublicationSidebarPageNode
        v-for="child in props.page.children"
        :key="child.id"
        :page="child"
        :site-id="props.siteId"
        :active-document-id="props.activeDocumentId"
      />
    </ul>
  </li>
</template>

<style scoped lang="scss">
.publication-sidebar-page-node {
  min-width: 0;
}

.publication-sidebar-page-node__link {
  position: relative;
  display: block;
  min-width: 0;
  overflow: hidden;
  padding: 0.25rem 0;
  color: var(--publication-c-text-2);
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1.5rem;
  text-decoration: none;
  text-overflow: ellipsis;
  white-space: nowrap;

  &::before {
    position: absolute;
    top: 0.375rem;
    bottom: 0.375rem;
    left: -1.0625rem;
    width: 0.125rem;
    border-radius: 0.125rem;
    background: transparent;
    content: "";
    transition: background-color 0.25s;
  }

  &:hover,
  &:focus-visible {
    color: var(--publication-c-brand-1);
  }

  &.is-active,
  &.router-link-active.router-link-exact-active {
    color: var(--publication-c-brand-1);
    font-weight: 600;

    &::before {
      background: var(--publication-c-brand-1);
    }
  }
}

.publication-sidebar-page-node__children {
  display: grid;
  gap: 0;
  margin: 0.125rem 0 0;
  padding: 0 0 0 1rem;
  list-style: none;
}
</style>

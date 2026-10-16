<script setup lang="ts">
import type { PublicationSiteDocumentPageProps } from './typing'
import { computed } from 'vue'
import PublicationDocumentContent from '../../components/document-content'
import PublicationPageOutline from '../../components/page-outline'
import PublicationSidebarTree from '../../components/sidebar-tree'

const props = withDefaults(defineProps<PublicationSiteDocumentPageProps>(), {
  activeDocumentId: null,
  isLoading: false,
})
const effectiveActiveDocumentId = computed(() => props.activeDocumentId ?? props.document?.documentId ?? null)
</script>

<template>
  <div class="publication-site-document-page">
    <aside class="publication-site-document-page__sidebar">
      <PublicationSidebarTree
        :groups="props.sidebarGroups"
        :site-id="props.siteId"
        :active-document-id="effectiveActiveDocumentId"
      />
    </aside>

    <main class="publication-site-document-page__content">
      <div class="publication-site-document-page__content-container">
        <ElSkeleton
          v-if="props.isLoading"
          class="publication-site-document-page__content-skeleton"
          animated
        >
          <template #template>
            <ElSkeletonItem class="publication-site-document-page__skeleton-meta" variant="text" />
            <ElSkeletonItem class="publication-site-document-page__skeleton-title" variant="h1" />
            <ElSkeletonItem class="publication-site-document-page__skeleton-heading" variant="h3" />
            <ElSkeletonItem class="publication-site-document-page__skeleton-line" variant="text" />
            <ElSkeletonItem class="publication-site-document-page__skeleton-line" variant="text" />
            <ElSkeletonItem class="publication-site-document-page__skeleton-line is-short" variant="text" />
            <div class="publication-site-document-page__skeleton-code">
              <ElSkeletonItem class="publication-site-document-page__skeleton-code-title" variant="text" />
              <ElSkeletonItem
                v-for="line in 6"
                :key="line"
                class="publication-site-document-page__skeleton-code-line"
                :class="{ 'is-indented': line % 3 === 0, 'is-short': line === 6 }"
                variant="text"
              />
            </div>
          </template>
        </ElSkeleton>

        <PublicationDocumentContent
          v-else-if="props.document"
          :document="props.document"
          :body="props.body"
          layout="site"
        />
      </div>
    </main>

    <aside class="publication-site-document-page__aside">
      <div class="publication-site-document-page__aside-curtain" />
      <div class="publication-site-document-page__aside-container">
        <ElSkeleton
          v-if="props.isLoading"
          class="publication-site-document-page__outline-skeleton"
          animated
        >
          <template #template>
            <ElSkeletonItem class="publication-site-document-page__outline-skeleton-title" variant="text" />
            <ElSkeletonItem class="publication-site-document-page__outline-skeleton-line" variant="text" />
            <ElSkeletonItem class="publication-site-document-page__outline-skeleton-line" variant="text" />
            <ElSkeletonItem class="publication-site-document-page__outline-skeleton-line is-short" variant="text" />
          </template>
        </ElSkeleton>
        <PublicationPageOutline v-else :items="props.outline" />
      </div>
    </aside>
  </div>
</template>

<style scoped lang="scss">
.publication-site-document-page {
  display: grid;
  min-height: calc(100vh - var(--publication-nav-height));
  min-width: 0;
  width: 100%;
  grid-template-columns: minmax(0, 1fr);
}

.publication-site-document-page__sidebar {
  box-sizing: border-box;
  position: sticky;
  top: var(--publication-nav-height);
  display: none;
  height: calc(100vh - var(--publication-nav-height));
  min-width: 0;
  align-self: start;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 2rem 2rem 6rem;
  border-right: 1px solid var(--publication-c-gutter);
  background: var(--publication-c-bg-alt);
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

.publication-site-document-page__content {
  min-width: 0;
  padding: 2rem 1.5rem 6rem;
}

.publication-site-document-page__content-container {
  width: min(100%, 43rem);
  margin: 0 auto;
}

.publication-site-document-page__content-skeleton {
  width: min(100%, 43rem);
}

.publication-site-document-page__skeleton-meta {
  display: block;
  width: 9rem;
  height: 1rem;
  margin-bottom: 1.25rem;
}

.publication-site-document-page__skeleton-title {
  display: block;
  width: min(22rem, 72%);
  height: 2.5rem;
  margin: 0 0 2rem;
}

.publication-site-document-page__content-skeleton .publication-site-document-page__skeleton-title {
  margin-inline: 0;
}

.publication-site-document-page__skeleton-heading {
  display: block;
  width: min(14rem, 52%);
  height: 1.75rem;
  margin-bottom: 1.25rem;
}

.publication-site-document-page__skeleton-line {
  display: block;
  width: 100%;
  height: 1rem;
  margin-top: 0.875rem;

  &.is-short {
    width: 62%;
  }
}

.publication-site-document-page__skeleton-code {
  display: grid;
  gap: 0.75rem;
  margin-top: 2rem;
  padding: 1rem 1.25rem;
  border: 1px solid var(--publication-c-gutter);
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--publication-c-bg-soft) 68%, transparent);
}

.publication-site-document-page__skeleton-code-title {
  width: 6.5rem;
  height: 0.875rem;
}

.publication-site-document-page__skeleton-code-line {
  width: 82%;
  height: 0.875rem;

  &.is-indented {
    width: 68%;
    margin-left: 1.5rem;
  }

  &.is-short {
    width: 42%;
  }
}

.publication-site-document-page__aside {
  box-sizing: border-box;
  position: sticky;
  top: var(--publication-nav-height);
  display: none;
  height: calc(100vh - var(--publication-nav-height));
  min-width: 0;
  align-self: start;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 3rem 2rem 2rem;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

.publication-site-document-page__aside-curtain {
  position: fixed;
  bottom: 0;
  z-index: 10;
  display: none;
  width: 14rem;
  height: 2rem;
  background: linear-gradient(transparent, var(--publication-c-bg) 70%);
  pointer-events: none;
}

.publication-site-document-page__aside-container {
  min-height: calc(100vh - var(--publication-nav-height) - 3rem);
  padding-bottom: 2rem;
}

.publication-site-document-page__outline-skeleton {
  padding-left: 1rem;
}

.publication-site-document-page__outline-skeleton-title {
  width: 4.5rem;
  height: 1rem;
  margin-bottom: 1rem;
}

.publication-site-document-page__outline-skeleton-line {
  display: block;
  width: 8rem;
  height: 0.875rem;
  margin-top: 0.875rem;

  &.is-short {
    width: 5.5rem;
  }
}

@media (min-width: 640px) {
  .publication-site-document-page__content {
    padding: 3rem 2rem 8rem;
  }
}

@media (min-width: 960px) {
  .publication-site-document-page {
    max-width: var(--publication-layout-max-width);
    margin: 0 auto;
    grid-template-columns: var(--publication-sidebar-width) minmax(0, 1fr);
  }

  .publication-site-document-page__sidebar {
    display: block;
  }

  .publication-site-document-page__content {
    padding: 3rem 2rem 8rem;
  }
}

@media (min-width: 1280px) {
  .publication-site-document-page {
    grid-template-columns: var(--publication-sidebar-width) minmax(0, 1fr) var(--publication-aside-width);
  }

  .publication-site-document-page__aside,
  .publication-site-document-page__aside-curtain {
    display: block;
  }
}
</style>

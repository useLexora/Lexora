<script setup lang="ts">
import type { PublicationPageOutlineProps } from './typing'
import { useI18n } from 'vue-i18n'

defineOptions({
  name: 'PublicationPageOutline',
})

const props = withDefaults(defineProps<PublicationPageOutlineProps>(), {
  showTitle: true,
})
const { t } = useI18n()
</script>

<template>
  <nav
    v-if="props.items.length"
    class="publication-page-outline"
    :class="{ 'publication-page-outline--nested': !props.showTitle }"
    :aria-label="t('docs.publicReader.pageNavigation')"
  >
    <p v-if="props.showTitle" class="publication-page-outline__title">
      {{ t('docs.publicReader.pageNavigation') }}
    </p>

    <ul class="publication-page-outline__list">
      <li v-for="item in props.items" :key="item.id" class="publication-page-outline__item">
        <a class="publication-page-outline__link" :href="`#${item.id}`">
          {{ item.title }}
        </a>
        <PublicationPageOutline v-if="item.children.length" :items="item.children" :show-title="false" />
      </li>
    </ul>
  </nav>
</template>

<style scoped lang="scss">
.publication-page-outline {
  position: relative;
  min-width: 0;
  padding-left: 1rem;
  color: var(--publication-c-text-2);
  font-size: 0.8125rem;
  font-weight: 500;
}

.publication-page-outline--nested {
  margin-top: 0.125rem;
  margin-left: 0.5rem;
  padding-left: 0.75rem;
}

.publication-page-outline__title {
  margin: 0;
  color: var(--publication-c-text-1);
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 2rem;
}

.publication-page-outline__list {
  display: grid;
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.publication-page-outline__link {
  display: block;
  overflow: hidden;
  color: inherit;
  line-height: 1.75rem;
  text-decoration: none;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.publication-page-outline__link {
  &:hover,
  &:focus-visible {
    color: var(--publication-c-brand-1);
  }
}
</style>

<script setup lang="ts">
import type { LoadingProps } from './typing'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { SvgIcon } from '@/components/svg-icon'
import { SvgIconCategory } from '@/components/svg-icon/typing'

const props = withDefaults(defineProps<LoadingProps>(), {
  title: '',
  description: '',
  icon: 'spinner-orbit',
  iconCategory: SvgIconCategory.UI,
  compact: false,
})
const { t } = useI18n()

const displayTitle = computed(() => props.title.trim() || t('common.loadingTitle'))
const displayDescription = computed(() => props.description.trim() || t('common.loadingDescription'))
const shouldSpin = computed(() => props.icon === 'spinner-orbit')
</script>

<template>
  <div class="app-loading" :class="{ 'is-compact': props.compact }" role="status" aria-live="polite">
    <span class="app-loading__figure" aria-hidden="true">
      <SvgIcon
        :category="props.iconCategory"
        :icon="props.icon"
        :class="[props.iconClass, { 'animate-spin': shouldSpin }]"
        size="1.45rem"
      />
    </span>

    <div class="app-loading__content">
      <p class="app-loading__title">
        {{ displayTitle }}
      </p>
      <p class="app-loading__description">
        {{ displayDescription }}
      </p>
    </div>

    <slot />
  </div>
</template>

<style scoped lang="scss">
.app-loading {
  display: flex;
  min-height: 12rem;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 0.875rem;
  padding: 2rem;
  text-align: center;

  &.is-compact {
    min-height: 5rem;
    gap: 0.625rem;
    padding: 1rem;
  }
}

.app-loading__figure {
  display: inline-flex;
  width: 3.5rem;
  height: 3.5rem;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--brand-border-base) 72%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--brand-bg-surface) 92%, var(--brand-fill-lighter));
  box-shadow: var(--brand-shadow-hairline);
  color: var(--brand-primary);
}

.app-loading.is-compact .app-loading__figure {
  width: 2.75rem;
  height: 2.75rem;
}

.app-loading__content {
  display: grid;
  gap: 0.25rem;
}

.app-loading__title {
  margin: 0;
  color: var(--brand-text-primary);
  font-size: 0.9375rem;
  font-weight: 700;
  line-height: 1.5;
}

.app-loading__description {
  max-width: 18rem;
  margin: 0;
  color: var(--brand-text-tertiary);
  font-size: 0.875rem;
  line-height: 1.65;
}

.app-loading.is-compact .app-loading__title {
  font-size: 0.875rem;
}

.app-loading.is-compact .app-loading__description {
  font-size: 0.8125rem;
  line-height: 1.55;
}
</style>

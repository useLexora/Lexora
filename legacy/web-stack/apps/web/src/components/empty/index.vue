<script setup lang="ts">
import type { EmptyProps } from './typing'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { SvgIcon } from '@/components/svg-icon'

const props = withDefaults(defineProps<EmptyProps>(), {
  title: '',
  icon: '',
  iconCategory: 'ui',
  imageSize: 72,
  compact: false,
})
const { t } = useI18n()

const hasTitle = computed(() => props.title.trim().length > 0)
const description = computed(() => props.description ?? t('common.emptyDescription'))
const hasDescription = computed(() => description.value.trim().length > 0)
const hasCustomIcon = computed(() => props.icon.trim().length > 0)
const figureSize = computed(() => props.compact && props.imageSize === 72 ? 60 : props.imageSize)
</script>

<template>
  <ElEmpty
    class="app-empty"
    :class="{ 'is-compact': props.compact }"
    :image-size="figureSize"
    description=""
    :style="{ '--app-empty-figure-size': `${figureSize}px` }"
  >
    <template #image>
      <span class="app-empty__figure" aria-hidden="true">
        <span v-if="hasCustomIcon" class="app-empty__icon">
          <SvgIcon
            :category="props.iconCategory"
            :icon="props.icon"
            :class="props.iconClass"
            size="1.45rem"
          />
        </span>
        <span v-else class="app-empty__box">
          <svg class="app-empty__box-svg" viewBox="0 0 96 80" fill="none" role="presentation" aria-hidden="true">
            <ellipse class="app-empty__box-shadow" cx="48" cy="71" rx="30" ry="5" />
            <path class="app-empty__box-lid" d="M19 24.5L27.5 14H68.5L77 24.5V33H19V24.5Z" />
            <path class="app-empty__box-body" d="M22 33H74V62C74 66.4183 70.4183 70 66 70H30C25.5817 70 22 66.4183 22 62V33Z" />
            <rect class="app-empty__box-handle" x="37.5" y="43" width="21" height="7.5" rx="3.75" />
            <path class="app-empty__box-line" d="M34 58.5H62" />
            <path class="app-empty__box-line is-short" d="M34 64H57" />
          </svg>
        </span>
      </span>
    </template>

    <template #description>
      <div class="app-empty__content">
        <p v-if="hasTitle" class="app-empty__title">
          {{ props.title }}
        </p>
        <p v-if="hasDescription" class="app-empty__description">
          {{ description }}
        </p>
      </div>
    </template>

    <slot />
  </ElEmpty>
</template>

<style scoped lang="scss">
.app-empty {
  --app-empty-figure-size: 4.5rem;

  display: flex;
  min-height: 12rem;
  align-items: center;
  justify-content: center;

  &.is-compact {
    --app-empty-figure-size: 3.75rem;

    min-height: 8rem;
  }

  :deep(.el-empty__image) {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  :deep(.el-empty__description) {
    margin-top: 1rem;
  }

  :deep(.el-empty__bottom) {
    margin-top: 0.875rem;
  }
}

.app-empty__figure {
  position: relative;
  display: inline-flex;
  width: var(--app-empty-figure-size);
  height: var(--app-empty-figure-size);
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--brand-bg-surface) 96%, var(--brand-primary) 4%),
      color-mix(in srgb, var(--brand-fill-lighter) 88%, var(--brand-bg-surface))
    );
  box-shadow: var(--brand-shadow-hairline);
  color: color-mix(in srgb, var(--brand-primary) 88%, var(--brand-text-primary));

  &::before {
    position: absolute;
    inset: 0.5rem;
    border-radius: 38%;
    background: color-mix(in srgb, var(--brand-bg-surface) 70%, transparent);
    content: '';
  }
}

.app-empty__icon,
.app-empty__box {
  position: relative;
  z-index: 1;
}

.app-empty__icon {
  display: inline-flex;
  width: 2.75rem;
  height: 2.75rem;
  align-items: center;
  justify-content: center;
  border-radius: 1rem;
  background: var(--brand-bg-surface);
  box-shadow:
    0 0.5rem 1.25rem color-mix(in srgb, var(--brand-text-primary) 8%, transparent),
    inset 0 0 0 1px color-mix(in srgb, var(--brand-border-base) 70%, transparent);

  :deep(svg) {
    color: color-mix(in srgb, var(--brand-primary) 76%, var(--brand-text-primary));
  }
}

.app-empty__box {
  display: inline-flex;
  width: 82%;
  height: 82%;
  align-items: center;
  justify-content: center;
}

.app-empty__box-svg {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.app-empty__box-shadow {
  fill: color-mix(in srgb, var(--brand-text-primary) 7%, transparent);
}

.app-empty__box-lid {
  fill: color-mix(in srgb, var(--brand-primary) 15%, var(--brand-fill-light));
  stroke: color-mix(in srgb, var(--brand-primary) 48%, var(--brand-text-secondary));
  stroke-linejoin: round;
  stroke-width: 2.4;
}

.app-empty__box-body {
  fill: color-mix(in srgb, var(--brand-bg-surface) 90%, var(--brand-fill-lighter));
  stroke: color-mix(in srgb, var(--brand-primary) 42%, var(--brand-text-secondary));
  stroke-linejoin: round;
  stroke-width: 2.4;
}

.app-empty__box-handle {
  fill: color-mix(in srgb, var(--brand-primary) 36%, var(--brand-text-secondary));
  stroke: color-mix(in srgb, var(--brand-primary) 48%, var(--brand-text-secondary));
  stroke-width: 1.6;
}

.app-empty__box-line {
  stroke: color-mix(in srgb, var(--brand-text-tertiary) 28%, transparent);
  stroke-linecap: round;
  stroke-width: 2.1;
}

.app-empty__content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
}

.app-empty__title {
  margin: 0;
  color: var(--brand-text-primary);
  font-size: 0.9375rem;
  font-weight: 700;
  line-height: 1.5;
}

.app-empty__description {
  max-width: 18rem;
  margin: 0;
  color: var(--brand-text-tertiary);
  font-size: 0.875rem;
  line-height: 1.65;
}
</style>

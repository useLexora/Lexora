<script setup lang="ts">
import type { AdminMetricCardProps } from './typing'

defineProps<AdminMetricCardProps>()
</script>

<template>
  <ElCard shadow="hover" body-class="console-metric-card__body p-5" class="console-metric-card">
    <div class="console-metric-card__header flex items-start justify-between gap-3">
      <div class="console-metric-card__content flex flex-col gap-1">
        <p class="console-metric-card__label text-[10px] font-bold uppercase text-secondary">
          {{ label }}
        </p>
        <div class="console-metric-card__value text-2xl font-bold text-main">
          {{ value }}
        </div>
      </div>
      <SvgIcon
        v-if="icon"
        :category="iconCategory"
        :icon="icon"
        size="1.25rem"
        class="console-metric-card__icon text-[1.25rem]"
      />
    </div>
    <p class="console-metric-card__detail mt-4 text-xs leading-[1.375] text-secondary">
      {{ detail }}
    </p>
  </ElCard>
</template>

<style scoped lang="scss">
.console-metric-card {
  border-color: color-mix(in srgb, var(--brand-border-base) 80%, transparent);
  transition:
    border-color 0.3s ease,
    color 0.3s ease;

  &:hover {
    border-color: color-mix(in srgb, var(--brand-primary) 40%, transparent);
  }

  .console-metric-card__value {
    transition: color 0.3s ease;
  }

  .console-metric-card__icon {
    color: color-mix(in srgb, var(--brand-text-secondary) 40%, transparent);
    transition: color 0.3s ease;
  }

  &:hover {
    .console-metric-card__value,
    .console-metric-card__icon {
      color: var(--brand-primary);
    }
  }
}
</style>

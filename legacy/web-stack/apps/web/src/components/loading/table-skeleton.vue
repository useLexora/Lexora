<script setup lang="ts">
const props = withDefaults(defineProps<{
  rows?: number
  compact?: boolean
}>(), {
  rows: 4,
  compact: false,
})
</script>

<template>
  <ElSkeleton
    animated
    class="app-table-skeleton"
    :class="{ 'is-compact': props.compact }"
  >
    <template #template>
      <div class="app-table-skeleton__rows">
        <ElSkeletonItem
          v-for="row in props.rows"
          :key="row"
          variant="rect"
          class="app-table-skeleton__row"
        />
      </div>
    </template>
  </ElSkeleton>
</template>

<style scoped lang="scss">
.app-table-skeleton {
  width: 100%;
  padding: 1rem 1.25rem;

  &.is-compact {
    padding: 0.75rem 1rem;
  }
}

.app-table-skeleton__rows {
  display: grid;
  gap: 0.75rem;
}

.app-table-skeleton__row {
  height: 2.5rem;
  border-radius: 6px;
}

.app-table-skeleton.is-compact .app-table-skeleton__row {
  height: 2rem;
}
</style>

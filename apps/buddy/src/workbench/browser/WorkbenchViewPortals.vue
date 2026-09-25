<script setup lang="ts">
import type { WorkbenchView } from '../common/workbench'
import { computed, useTemplateRef } from 'vue'
import { useWorkbench } from './workbenchContext'
import WorkbenchViewBoundary from './WorkbenchViewBoundary.vue'

defineSlots<{ default: (props: { view: WorkbenchView, visible: boolean }) => unknown }>()
const { controller, layout, labels, viewTarget, viewVisible } = useWorkbench()
const parking = useTemplateRef<HTMLElement>('parking')
const views = computed(() => Object.values(layout.value.views))
</script>

<template>
  <div ref="parking" hidden />
  <template v-if="parking">
    <Teleport v-for="view in views" :key="view.id" defer :to="viewTarget(view.id) ?? parking">
      <section :id="`workbench-view-${view.id}`" class="workbench__view" role="region" :aria-label="view.title" :data-view-id="view.id" :data-resource-id="view.resource.id">
        <WorkbenchViewBoundary>
          <slot v-if="controller.registry.views.has(view.type)" :view="view" :visible="viewVisible(view.id)" />
          <div v-else class="workbench__missing">
            <p>{{ labels.missing }}</p><code>{{ view.type }}</code>
          </div>
        </WorkbenchViewBoundary>
      </section>
    </Teleport>
  </template>
</template>

<style scoped>
.workbench__view { display: flex; flex: 1; flex-direction: column; width: 100%; height: 100%; min-height: 0; min-width: 0; overflow: hidden; }
.workbench__missing { margin: auto; padding: 24px; color: var(--buddy-text-secondary); text-align: center; }
</style>

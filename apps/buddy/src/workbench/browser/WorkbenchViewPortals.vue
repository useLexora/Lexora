<script setup lang="ts">
import type { WorkbenchView } from '../common/workbench'
import { computed, useTemplateRef } from 'vue'
import WorkbenchUiScope from '@/shared/ui/contributions/WorkbenchUiScope.vue'
import { panes } from '../common/workbench'
import { useWorkbench } from './workbenchContext'
import WorkbenchViewBoundary from './WorkbenchViewBoundary.vue'

defineSlots<{ default: (props: { view: WorkbenchView, visible: boolean }) => unknown }>()
const { controller, layout, revision, labels, viewTarget, viewVisible } = useWorkbench()
const parking = useTemplateRef<HTMLElement>('parking')
const views = computed(() => {
  void revision.value
  return controller.renderedViews
})
</script>

<template>
  <div ref="parking" hidden />
  <template v-if="parking">
    <Teleport v-for="view in views" :key="view.id" defer :to="viewTarget(view.id) ?? parking">
      <section :id="`workbench-view-${view.id}`" class="workbench__view flex flex-1 flex-col w-full h-full min-h-0 min-w-0 overflow-hidden" role="region" :aria-label="view.title" :data-view-id="view.id" :data-resource-id="view.resource.id">
        <WorkbenchUiScope :instance-id="view.mountInstanceId ?? controller.navigation.find(view.id)?.paneId ?? panes(layout.root).find(pane => pane.view === view.id)?.id">
          <WorkbenchViewBoundary @error="controller.navigation.fail(view.id)">
            <slot v-if="controller.registry.views.has(view.type)" :view="view" :visible="viewVisible(view.id)" />
            <div v-else class="m-auto p-[24px] text-muted text-center">
              <p>{{ labels.missing }}</p><code>{{ view.type }}</code>
            </div>
          </WorkbenchViewBoundary>
        </WorkbenchUiScope>
      </section>
    </Teleport>
  </template>
</template>

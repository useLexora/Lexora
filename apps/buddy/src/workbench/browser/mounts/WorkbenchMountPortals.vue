<script setup lang="ts">
import { workbenchMountKey } from '@buddy-shared/workbench/workbenchUi'
import { computed, useTemplateRef } from 'vue'
import { useWorkbench } from '../workbenchContext'
import WorkbenchSurface from '../WorkbenchSurface.vue'
import { workbenchMountStyle } from './workbenchMountStyle'

const { controller, layout, revision, mountPoints } = useWorkbench()
const parking = useTemplateRef<HTMLElement>('parking')
const mounts = computed(() => {
  void revision.value
  return Object.values(layout.value.views).flatMap((view) => {
    const placement = view.placement ? controller.registry.placements.get(view.placement) : null
    if (view.location !== 'mount' || !placement || placement.viewType !== view.type)
      return []
    const presentation = { target: placement.target, ...placement.presentation, ...view.presentation }
    return [{ view, target: controller.matchesViewContext(view) ? mountPoints.value.get(workbenchMountKey(presentation.target, view.mountInstanceId)) : null, style: { ...workbenchMountStyle(presentation), ...(placement.interaction === 'regions' ? { pointerEvents: 'none' as const } : {}) } }]
  })
})
</script>

<template>
  <div ref="parking" hidden />
  <template v-if="parking">
    <Teleport v-for="mount in mounts" :key="mount.view.id" :to="mount.target ?? parking">
      <WorkbenchSurface :view-id="mount.view.id" :visible="!!mount.target" class="workbench-mount" :data-mount-view="mount.view.id" :style="mount.style" />
    </Teleport>
  </template>
</template>

<style scoped>
.workbench-mount { position: static; flex: 0 0 auto; order: 1; width: 100%; height: 56px; max-width: 100%; max-height: 100%; overflow: hidden; }
</style>

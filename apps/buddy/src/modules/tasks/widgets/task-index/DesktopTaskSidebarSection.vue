<script setup lang="ts" generic="T extends Record<string, unknown>">
import { NVirtualList } from 'naive-ui'
import { computed, nextTick, onMounted, useTemplateRef } from 'vue'
import DesktopTaskSidebarSectionHeader from '@/modules/tasks/widgets/task-index/DesktopTaskSidebarSectionHeader.vue'
import {
  DESKTOP_TASK_SIDEBAR_LIST_PADDING_TOP,
  DESKTOP_TASK_SIDEBAR_ROW_SIZE,
  resolveDesktopTaskSidebarSectionLayout,
} from '@/modules/tasks/widgets/task-index/taskSidebarLayout'

const props = defineProps<{
  items: ReadonlyArray<T>
  keyField: string
  label: string
  priority: number
  scrollIndex?: number
  section: 'pinned' | 'spaces' | 'tasks'
  showAdd?: boolean
}>()
const emit = defineEmits<{
  add: []
  scroll: [index: number]
}>()
defineSlots<{
  default: (props: { item: T }) => unknown
}>()
const expanded = defineModel<boolean>('expanded', { required: true })
const layout = computed(() => resolveDesktopTaskSidebarSectionLayout({
  expanded: expanded.value,
  priority: props.priority,
  rowCount: props.items.length,
}))
const virtualItems = computed(() => [...props.items])
const sectionElement = useTemplateRef<HTMLElement>('sectionElement')

onMounted(async () => {
  const index = props.scrollIndex ?? 0
  if (index <= 0)
    return
  const target = DESKTOP_TASK_SIDEBAR_LIST_PADDING_TOP + index * DESKTOP_TASK_SIDEBAR_ROW_SIZE
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await nextTick()
    await new Promise(resolve => requestAnimationFrame(resolve))
    const list = sectionElement.value?.querySelector('.v-vl')
    if (!(list instanceof HTMLElement))
      continue
    list.scrollTop = target
    if (list.scrollTop > 0)
      return
  }
})

function handleScroll(event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLElement))
    return
  const offset = Math.max(0, target.scrollTop - DESKTOP_TASK_SIDEBAR_LIST_PADDING_TOP)
  emit('scroll', Math.floor(offset / DESKTOP_TASK_SIDEBAR_ROW_SIZE))
}
const sectionStyle = computed(() => ({
  '--buddy-task-sidebar-section-natural-size': layout.value.naturalSize,
  '--buddy-task-sidebar-section-priority': layout.value.priority,
}))
</script>

<template>
  <section
    ref="sectionElement"
    class="desktop-task-sidebar__section"
    :class="[`is-${layout.mode}`, `desktop-task-sidebar__${section}`]"
    :style="sectionStyle"
  >
    <DesktopTaskSidebarSectionHeader
      :expanded="expanded"
      :label="label"
      :show-add="showAdd"
      @add="emit('add')"
      @toggle="expanded = !expanded"
    />
    <NVirtualList
      v-show="expanded"
      class="desktop-task-sidebar__virtual-list"
      :item-size="DESKTOP_TASK_SIDEBAR_ROW_SIZE"
      :items="virtualItems"
      :key-field="keyField"
      :on-scroll="handleScroll"
      :padding-top="DESKTOP_TASK_SIDEBAR_LIST_PADDING_TOP"
    >
      <template #default="{ item }">
        <slot :item="item" />
      </template>
    </NVirtualList>
  </section>
</template>

<style scoped lang="scss">
.desktop-task-sidebar__section {
  display: flex;
  min-height: var(--buddy-task-sidebar-section-header-size);
  flex-direction: column;
  overflow: hidden;

  &.is-weighted {
    max-height: var(--buddy-task-sidebar-section-natural-size);
    flex: var(--buddy-task-sidebar-section-priority) 1 0;
  }

  &.is-collapsed {
    flex: 0 0 var(--buddy-task-sidebar-section-header-size);
  }
}

.desktop-task-sidebar__virtual-list {
  height: 100%;
  min-height: 0;
  flex: 1;
}
</style>

<script setup lang="ts">
import { BUILTIN_BUDDY_ID } from '@buddy-shared/buddies/buddyApi'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import WorkbenchLayout from '@/workbench/browser/layout/WorkbenchLayout.vue'
import DesktopBuddiesSidebar from '../widgets/DesktopBuddiesSidebar.vue'
import DesktopBuddyProfile from '../widgets/DesktopBuddyProfile.vue'

withDefaults(defineProps<{ buddyId?: string }>(), { buddyId: BUILTIN_BUDDY_ID })
const { language } = useDesktopUi()
</script>

<template>
  <WorkbenchLayout :language="language">
    <template #sidebar>
      <DesktopBuddiesSidebar :buddy-id="buddyId" />
    </template>
    <template #workspace>
      <DesktopBuddyProfile :key="buddyId" :buddy-id="buddyId" />
    </template>
  </WorkbenchLayout>
</template>

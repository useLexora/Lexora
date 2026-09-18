<script setup lang="ts">
import { useRoute } from 'vue-router'
import DesktopExtensionPage from '../widgets/DesktopExtensionPage.vue'

const route = useRoute()
</script>

<template>
  <DesktopExtensionPage :key="String(route.params.extensionId)" :extension-id="String(route.params.extensionId)" />
</template>

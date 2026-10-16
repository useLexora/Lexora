<script setup lang="ts">
import AiProviderConsole from '@/components/ai-provider-console'
</script>

<template>
  <div class="settings-providers-panel box-border h-full min-h-[calc(var(--app-shell-height)-var(--default-header-height))] bg-fill-lighter px-5 py-5 pb-6">
    <div class="mx-auto h-full w-full max-w-[var(--page-mode-console-max-width)]">
      <AiProviderConsole class="h-full min-h-[38rem]" mode="user" />
    </div>
  </div>
</template>

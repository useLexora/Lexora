<script setup lang="ts">
import type { ApplicationSettingsProps } from './typing'
import DesktopSpeechInputSettings from './DesktopSpeechInputSettings.vue'
import DesktopSpeechOutputSettings from './DesktopSpeechOutputSettings.vue'

defineProps<ApplicationSettingsProps>()
</script>

<template>
  <section v-if="config" class="grid gap-7 [container-type:inline-size]" data-testid="speech-settings">
    <DesktopSpeechOutputSettings :config="config" :error="error" :language="language" :update-settings="updateSettings" />
    <DesktopSpeechInputSettings :config="config" :error="error" :language="language" :update-settings="updateSettings" />
  </section>
</template>

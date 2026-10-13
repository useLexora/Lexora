<script setup lang="ts">
import type { ExtensionCompatibilityIssue } from '@buddy-shared/extensions/extensionCompatibility'
import { extensionUpgradeSuggested } from '@buddy-shared/extensions/extensionCompatibility'
import { computed } from 'vue'
import { DesktopUpdateDownloadLink } from '@/modules/updates/ui'
import { extensionCompatibilityLabel } from '../extensionCompatibilityLabels'

const props = defineProps<{ issue: ExtensionCompatibilityIssue, language: string, version?: string }>()
const description = computed(() => extensionCompatibilityLabel(props.issue, props.language))
</script>

<template>
  <div class="extension-compatibility grid gap-2 text-[12px] leading-[1.6] text-muted [overflow-wrap:anywhere]" role="status">
    <span v-if="version" class="text-strong font-500">{{ language === 'en-US' ? 'New version' : '新版本' }} {{ version }}</span>
    <p class="m-0">
      {{ description }}
    </p>
    <div v-if="extensionUpgradeSuggested(issue)">
      <DesktopUpdateDownloadLink :required-version="issue.requiredVersion" :language="language" />
    </div>
  </div>
</template>

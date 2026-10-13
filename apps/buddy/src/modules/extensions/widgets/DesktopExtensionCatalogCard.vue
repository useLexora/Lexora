<script setup lang="ts">
import type { ExtensionMetadata } from '@buddy-shared/extensions/extensionManifest'
import { NEllipsis, NTag } from 'naive-ui'
import DesktopPluginIcon from '@/shared/ui/icon/DesktopPluginIcon.vue'

defineProps<{ manifest: ExtensionMetadata, iconUrl?: string, language: string }>()
</script>

<template>
  <article class="flex min-w-0 flex-col gap-[10px] border border-solid border-border rounded-micro bg-surface p-[18px]">
    <header class="flex min-w-0 items-center gap-[10px]">
      <DesktopPluginIcon :src="iconUrl" :size="28" />
      <h2 class="m-0 min-w-0 flex-1 text-strong text-[14px] font-600 leading-[1.5] [overflow-wrap:anywhere]">
        {{ manifest.name }}
      </h2>
      <span class="flex-none text-muted text-[11px]">{{ manifest.version }}</span>
    </header>
    <div class="flex min-w-0 items-center gap-2">
      <NEllipsis class="min-w-0 flex-1 text-muted text-[11px]">
        {{ manifest.author || (language === 'en-US' ? 'Unsigned' : '未署名') }}
      </NEllipsis>
    </div>
    <NEllipsis v-if="manifest.description" :line-clamp="2" class="text-muted text-[13px] leading-[1.7]">
      {{ manifest.description }}
    </NEllipsis>
    <div v-if="manifest.tags.length" class="flex flex-wrap gap-[6px]">
      <NTag v-for="tag in manifest.tags" :key="tag" size="small" :bordered="false">
        {{ tag }}
      </NTag>
    </div>
    <footer class="mt-auto flex min-w-0 flex-wrap items-center gap-1 pt-2">
      <slot name="actions" />
    </footer>
  </article>
</template>

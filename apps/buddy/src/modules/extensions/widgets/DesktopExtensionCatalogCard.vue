<script setup lang="ts">
import type { ExtensionMetadata } from '@buddy-shared/extensions/extensionManifest'
import { NEllipsis, NTag, NTooltip } from 'naive-ui'
import DesktopPluginIcon from '@/shared/ui/icon/DesktopPluginIcon.vue'

defineProps<{ manifest: ExtensionMetadata, iconUrl?: string, repository?: string, language: string }>()
</script>

<template>
  <article class="extension-catalog-card flex min-w-0 flex-col gap-[10px] border border-solid border-border rounded-micro bg-surface p-[18px]" data-theme-surface="panel">
    <header class="extension-catalog-card__header flex min-w-0 items-center gap-[10px]">
      <DesktopPluginIcon :src="iconUrl" :size="28" />
      <h2 class="m-0 min-w-0 flex-1 text-strong text-[14px] font-600 leading-[1.5] [overflow-wrap:anywhere]">
        {{ manifest.name }}
      </h2>
      <span class="flex-none text-muted text-[11px]">{{ manifest.version }}</span>
    </header>
    <div class="flex min-w-0 items-center gap-1.5 text-muted text-[11px]">
      <NEllipsis class="min-w-0">
        {{ manifest.author || (language === 'en-US' ? 'Unsigned' : '未署名') }}
      </NEllipsis>
      <template v-if="repository">
        <span class="flex-none select-none text-muted text-[11px] leading-none">·</span>
        <NTooltip trigger="hover">
          <template #trigger>
            <a
              :href="repository"
              target="_blank"
              rel="noopener noreferrer"
              class="flex-none inline-flex items-center text-muted hover:text-strong transition-colors cursor-pointer"
              :aria-label="language === 'en-US' ? 'View repository on GitHub' : '在 GitHub 查看源码'"
              @click.stop
            >
              <svg class="size-3.5 fill-current" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
              </svg>
            </a>
          </template>
          {{ repository }}
        </NTooltip>
      </template>
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

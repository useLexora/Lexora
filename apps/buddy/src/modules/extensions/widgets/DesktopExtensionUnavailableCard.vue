<script setup lang="ts">
import type { ExtensionUnavailableInstallation } from '@buddy-shared/extensions/extensionApi'
import { NButton, NEllipsis, NTag } from 'naive-ui'
import DesktopPluginIcon from '@/shared/ui/icon/DesktopPluginIcon.vue'
import DesktopExtensionCompatibilityHint from './DesktopExtensionCompatibilityHint.vue'
import DesktopExtensionTags from './DesktopExtensionTags.vue'

defineProps<{ item: ExtensionUnavailableInstallation, language: string }>()
</script>

<template>
  <article class="extension-unavailable-card box-border h-[200px] flex min-w-0 flex-col gap-2 border border-solid border-border rounded-micro bg-surface p-4" :data-unavailable-extension-id="item.manifest.id" data-theme-surface="panel">
    <header class="extension-unavailable-card__header flex min-w-0 flex-none items-start gap-3">
      <DesktopPluginIcon :size="28" />
      <div class="min-w-0 flex-1">
        <h2 class="m-0 min-w-0 text-strong text-[14px] font-600 leading-[1.5]">
          <NEllipsis>{{ item.manifest.name }}</NEllipsis>
        </h2>
        <p class="flex min-w-0 items-center gap-2 mt-1 mr-0 mb-0 ml-0 text-muted text-[11px]">
          <span class="flex-none">{{ item.manifest.version }}</span>
          <NEllipsis class="min-w-0">
            {{ item.manifest.author || (language === 'en-US' ? 'Unsigned' : '未署名') }}
          </NEllipsis>
        </p>
      </div>
      <div class="flex flex-none items-center gap-1">
        <NTag size="small" type="warning" :bordered="false">
          {{ language === 'en-US' ? 'Unavailable' : '暂不可用' }}
        </NTag>
        <DesktopExtensionCompatibilityHint :issue="item.incompatibility" :language="language" placement="bottom-end" />
      </div>
    </header>
    <div class="grid min-w-0 flex-none gap-[6px]">
      <NEllipsis v-if="item.manifest.description" :line-clamp="1" class="text-muted text-[13px] leading-[1.6]">
        {{ item.manifest.description }}
      </NEllipsis>
      <NEllipsis :line-clamp="1" class="text-muted text-[11px] leading-[1.6]">
        {{ language === 'en-US' ? 'Your plugin settings and private data are retained.' : '插件设置与私有数据已保留。' }}
      </NEllipsis>
    </div>
    <footer class="mt-auto flex min-w-0 flex-none flex-col gap-2">
      <DesktopExtensionTags :tags="item.manifest.tags" />
      <div class="flex items-center gap-1">
        <NButton type="primary" size="small" disabled>
          {{ language === 'en-US' ? 'Enable' : '启用' }}
        </NButton>
      </div>
    </footer>
  </article>
</template>

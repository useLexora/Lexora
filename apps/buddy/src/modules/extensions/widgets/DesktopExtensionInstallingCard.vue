<script setup lang="ts">
import type { ExtensionInstallation } from '@buddy-shared/extensions/extensionInstallation'
import type { ExtensionPendingInstall } from '../state/useExtensionOperations'
import { NEllipsis, NTag } from 'naive-ui'
import DesktopPluginIcon from '@/shared/ui/icon/DesktopPluginIcon.vue'
import DesktopExtensionInstallationStatus from './DesktopExtensionInstallationStatus.vue'

defineProps<{ installation: ExtensionPendingInstall, job?: ExtensionInstallation, language: string }>()
const emit = defineEmits<{ progress: [], dismiss: [] }>()
</script>

<template>
  <article class="extension-card box-border h-[200px] flex min-w-0 flex-col gap-2 border border-solid border-border rounded-micro bg-surface p-4" :data-extension-id="installation.manifest.id" :aria-busy="!installation.error" data-testid="extension-installing-card" data-theme-surface="panel">
    <header class="flex min-w-0 flex-none items-start gap-3">
      <DesktopPluginIcon :src="installation.iconUrl" :size="28" />
      <div class="min-w-0 flex-1">
        <h2 class="m-0 text-strong text-[14px] font-600 leading-[1.5]">
          <NEllipsis>{{ installation.manifest.name }}</NEllipsis>
        </h2>
        <p class="flex min-w-0 items-center gap-2 mt-1 mr-0 mb-0 ml-0 text-muted text-[11px]">
          <span>{{ installation.manifest.version }}</span>
          <NEllipsis>{{ installation.manifest.author || (language === 'en-US' ? 'Unsigned' : '未署名') }}</NEllipsis>
        </p>
      </div>
      <NTag size="small" :bordered="false" :type="installation.error ? 'warning' : 'default'">
        {{ installation.error ? (language === 'en-US' ? 'Failed' : '安装失败') : (language === 'en-US' ? 'Installing' : '安装中') }}
      </NTag>
    </header>
    <NEllipsis v-if="installation.manifest.description" :line-clamp="2" class="text-muted text-[13px] leading-[1.6]">
      {{ installation.manifest.description }}
    </NEllipsis>
    <footer class="mt-auto">
      <DesktopExtensionInstallationStatus :installation="installation" :job="job" :language="language" @progress="emit('progress')" @dismiss="emit('dismiss')" />
    </footer>
  </article>
</template>

<script setup lang="ts">
import { ArrowUpRight20Regular } from '@vicons/fluent'
import { NButton } from 'naive-ui'
import { satisfies } from 'semver'
import { shallowRef } from 'vue'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ requiredVersion: string, language: string }>()
const api = requireDesktopApi()
const checking = shallowRef(false)
const feedback = shallowRef('')

async function download() {
  if (checking.value)
    return
  checking.value = true
  feedback.value = ''
  try {
    const result = await api.app.checkForUpdates()
    if (result.status !== 'update_available' || !satisfies(result.latestVersion, props.requiredVersion, { includePrerelease: true })) {
      feedback.value = props.language === 'en-US' ? 'A suitable app update is not available yet. Please try again later.' : '暂时没有可用的应用新版本，请稍后再试。'
      return
    }
    await api.app.openReleasePage(result.releaseUrl)
  }
  catch {
    feedback.value = props.language === 'en-US' ? 'Could not open the app download page. Please try again.' : '暂时无法打开应用下载页面，请重试。'
  }
  finally {
    checking.value = false
  }
}
</script>

<template>
  <div class="grid justify-items-start gap-2">
    <NButton tag="a" role="link" text type="primary" :tabindex="checking ? -1 : 0" :loading="checking" :disabled="checking" @click.prevent="download" @keydown.enter.prevent="download">
      {{ language === 'en-US' ? 'Update Lexora' : '更新 Lexora' }}
      <DesktopIcon :component="ArrowUpRight20Regular" :size="14" class="ml-1" />
    </NButton>
    <p v-if="feedback" class="m-0 text-muted text-[12px] leading-[1.6]" role="status">
      {{ feedback }}
    </p>
  </div>
</template>

<script setup lang="ts">
import type { ShellCandidate } from '@buddy-shared/shell/shellProgram'
import type { SettingsGroup, SettingsItem, ShellSettingsRow } from '../../model/settingsRegistry'
import { resolveBuddyPlatform } from '@buddy-shared/platform'
import { NButton, NTable } from 'naive-ui'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { useSettingsContext } from '../../settingsContext'
import DesktopShellSettingsRow from './DesktopShellSettingsRow.vue'

const props = defineProps<{ settings: NonNullable<SettingsGroup['shells']>, items: readonly SettingsItem[], labelledBy: string }>()
const { pluginSettings, appInfo, applicationSettings: { language } } = useSettingsContext()
const candidates = shallowRef<ShellCandidate[]>([])
const detecting = shallowRef(false)
const failed = shallowRef(false)
const unsupportedPlatform = computed(() => appInfo.value ? !resolveBuddyPlatform(appInfo.value.platform).hostShellSupervision : false)
const configuration = computed(() => pluginSettings.configurations.value[props.settings.extensionId])
const rows = computed<ShellSettingsRow[]>(() => {
  const fields = new Map(props.items.flatMap(item => item.kind === 'plugin' ? [[item.field.item.key, item.field] as const] : []))
  return props.settings.candidates.map(candidate => ({
    id: candidate.id,
    enabled: fields.get(candidate.enabled)!,
    executable: fields.get(candidate.executable)!,
    priority: fields.get(candidate.priority)!,
  }))
})
let request = 0
onScopeDispose(() => request++)

async function detect() {
  if (!configuration.value)
    return
  const current = ++request
  detecting.value = true
  failed.value = false
  candidates.value = []
  try {
    const detected = await pluginSettings.detectShells(props.settings.extensionId)
    if (current === request)
      candidates.value = detected
  }
  catch {
    if (current === request)
      failed.value = true
  }
  finally {
    if (current === request)
      detecting.value = false
  }
}

watch(() => configuration.value ? JSON.stringify([props.settings.revision, configuration.value]) : null, () => void detect(), { immediate: true })
</script>

<template>
  <div data-testid="shell-settings-table">
    <div class="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
      <p class="m-0 flex-1 min-w-50 text-[12px] text-muted leading-[1.6]">
        {{ language === 'zh-CN' ? '只检测已有解释器，不安装软件。启用后供模型选择；设置从下一轮任务生效。' : 'Detects existing interpreters without installing software. Enabled choices apply to the next task turn.' }}
      </p>
      <NButton size="small" :disabled="!configuration || detecting || pluginSettings.pending.value.has(settings.extensionId)" :loading="detecting" @click="detect">
        {{ language === 'zh-CN' ? '重新检测' : 'Detect again' }}
      </NButton>
    </div>
    <p v-if="failed" class="mx-4 mt-0 mb-3 text-[12px] text-danger" role="alert">
      {{ language === 'zh-CN' ? '检测失败，请重试。已保存的配置未改变。' : 'Detection failed. Retry; the saved configuration is unchanged.' }}
    </p>
    <p v-if="unsupportedPlatform" class="mx-4 mt-0 mb-3 text-[12px] text-warning" role="status">
      {{ language === 'zh-CN' ? '当前平台尚不支持通过插件候选执行命令；检测成功不代表可以执行。' : 'Plugin-selected command execution is not supported on this platform, even when detection succeeds.' }}
    </p>
    <div class="overflow-x-auto" role="region" tabindex="0" :aria-labelledby="labelledBy">
      <NTable class="shell-settings-table min-w-190" size="small" :bordered="false">
        <thead>
          <tr>
            <th scope="col">
              {{ language === 'zh-CN' ? '解释器' : 'Interpreter' }}
            </th>
            <th scope="col">
              {{ language === 'zh-CN' ? '启用' : 'Enabled' }}
            </th>
            <th scope="col">
              {{ language === 'zh-CN' ? '检测结果' : 'Detection' }}
            </th>
            <th scope="col">
              {{ language === 'zh-CN' ? '可执行文件' : 'Executable' }}
            </th>
            <th scope="col">
              {{ language === 'zh-CN' ? '优先级' : 'Priority' }}
            </th>
          </tr>
        </thead>
        <tbody>
          <DesktopShellSettingsRow v-for="row in rows" :key="row.id" :row="row" :candidate="candidates.find(candidate => candidate.id === row.id)" :detecting="detecting" :failed="failed" />
        </tbody>
      </NTable>
    </div>
    <p class="m-0 border-t border-t-solid border-t-border px-4 py-3 text-[12px] text-muted leading-[1.6]">
      {{ language === 'zh-CN' ? '优先级 0 不改变平台默认；正数越小越优先，同数按表格顺序。仅选择你信任的解释器文件，检测会运行固定版本探针。' : 'Priority 0 keeps the platform default. Smaller positive numbers win; ties follow table order. Choose only trusted interpreter files: detection runs a fixed version probe.' }}
    </p>
  </div>
</template>

<style scoped lang="scss">
.shell-settings-table {
  :deep(td),
  :deep(th) {
    vertical-align: middle;
  }
}
</style>

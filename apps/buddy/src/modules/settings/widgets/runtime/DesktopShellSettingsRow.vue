<script setup lang="ts">
import type { ShellCandidate, ShellCandidateId } from '@buddy-shared/shell/shellProgram'
import type { ShellSettingsRow } from '../../model/settingsRegistry'
import { computed } from 'vue'
import { useSettingsContext } from '../../settingsContext'
import DesktopPluginSetting from '../plugins/DesktopPluginSetting.vue'
import DesktopShellExecutableSetting from './DesktopShellExecutableSetting.vue'

const props = defineProps<{ row: ShellSettingsRow, candidate?: ShellCandidate, detecting: boolean, failed: boolean }>()
const { pluginSettings, applicationSettings: { language } } = useSettingsContext()
const names: Record<ShellCandidateId, string> = {
  'bash': 'Bash',
  'git-bash': 'Git Bash',
  'zsh': 'Zsh',
  'sh': 'POSIX sh',
  'powershell7': 'PowerShell 7+',
  'powershell51': 'Windows PowerShell 5.1',
  'cmd': 'CMD',
}
const unsupported = computed(() => props.candidate?.reason === 'Not supported on this operating system')
const version = computed(() => props.candidate?.version.match(/\d+(?:\.\d+)+/)?.[0] ?? props.candidate?.version)
const reason = computed(() => {
  if (!props.candidate?.reason || unsupported.value)
    return ''
  if (language.value !== 'zh-CN')
    return props.candidate.reason
  const reasons: Record<string, string> = {
    'The configured executable must be an absolute local path': '需要本机解释器的绝对路径',
    'The executable failed its bounded version probe': '版本检测失败，请重新选择解释器',
    'No usable local installation was found': '未找到可用解释器',
  }
  return reasons[props.candidate.reason] ?? '未找到可用解释器，请检查所选文件'
})
</script>

<template>
  <tr :data-shell-id="row.id">
    <th scope="row" class="w-42 font-500 text-left">
      {{ names[row.id] }}
      <span v-if="version" class="mt-1 block text-[12px] font-400 text-muted">{{ version }}</span>
    </th>
    <td class="w-18">
      <DesktopPluginSetting :field="row.enabled" compact />
    </td>
    <td class="w-28">
      <span :class="candidate?.available && !detecting && !failed ? 'text-success' : 'text-muted'" role="status">
        {{ detecting ? (language === 'zh-CN' ? '检测中…' : 'Detecting…')
          : failed ? (language === 'zh-CN' ? '检测失败' : 'Detection failed')
            : !candidate ? (language === 'zh-CN' ? '待检测' : 'Not checked')
              : unsupported ? (language === 'zh-CN' ? '不适用' : 'Unsupported')
                : candidate.available ? (language === 'zh-CN' ? '已找到' : 'Found')
                  : (language === 'zh-CN' ? '不可用' : 'Unavailable') }}
      </span>
      <small v-if="reason && !detecting && !failed" class="mt-1 block text-[12px] text-muted">{{ reason }}</small>
    </td>
    <td class="min-w-68">
      <DesktopPluginSetting :field="row.executable" compact>
        <template #control="{ value, disabled, controlAttrs, save }">
          <DesktopShellExecutableSetting
            :value="typeof value === 'string' ? value : ''"
            :detected-path="candidate?.executable"
            :disabled="disabled || detecting"
            :language="language"
            :control-attrs="controlAttrs"
            :pick="() => pluginSettings.selectShellExecutable(row.executable.extensionId, row.id)"
            :save="save"
          />
        </template>
      </DesktopPluginSetting>
    </td>
    <td class="w-28 min-w-28">
      <DesktopPluginSetting :field="row.priority" compact />
    </td>
  </tr>
</template>

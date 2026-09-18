<script setup lang="ts">
import type { ExtensionInstallation } from '@buddy-shared/extensions/extensionInstallation'
import { NButton, NEmpty, NTag } from 'naive-ui'
import { computed } from 'vue'

const props = defineProps<{ jobs: ExtensionInstallation[], language: string }>()
const emit = defineEmits<{ cancel: [id: string] }>()
const en = computed(() => props.language === 'en-US')
const stages = computed<Record<string, string>>(() => en.value ? { download: 'Download', validate: 'Validate', review: 'Permissions', compile: 'Compile', install: 'Install', completed: 'Complete' } : { download: '获取插件', validate: '校验插件', review: '确认权限', compile: '编译', install: '安装', completed: '完成' })
const statuses = computed<Record<string, string>>(() => en.value ? { running: 'In progress', review: 'Awaiting confirmation', completed: 'Installed', failed: 'Failed', cancelled: 'Cancelled' } : { running: '进行中', review: '等待确认', completed: '已安装', failed: '失败', cancelled: '已取消' })
const messages = computed<Record<string, string>>(() => en.value ? { started: 'Started', permissions: 'Waiting for permission review', checking: 'Checking package format', compiled: 'Compilation succeeded', skipped: 'Compiled package; skipped', installing: 'Saving verified package', installed: 'Ready; updates take effect after restart' } : { started: '已开始', permissions: '等待确认插件权限', checking: '检查包格式', compiled: '编译成功', skipped: '已编译的插件包，跳过此步骤', installing: '保存已校验的插件包', installed: '安装完成；更新版本需重启插件后生效' })
const errors = computed((): Record<string, string> => en.value
  ? {}
  : {
      EXTENSION_SOURCE_COMPILE_FAILED: '源码编译失败，请展开日志查看文件与位置。',
      EXTENSION_SOURCE_IMPORT_DENIED: '源码包只能导入包内模块；含 npm 依赖的插件请先由作者打包。',
      EXTENSION_SOURCE_IMPORT_MISSING: '找不到导入的包内模块，请联系插件作者。',
      EXTENSION_COMPILE_TIMEOUT: '编译超时，编译进程已停止。',
      EXTENSION_COMPILER_STOPPED: '编译进程意外停止，已安装的插件未被替换。',
      EXTENSION_INSTALL_INTERRUPTED: '上次安装被应用退出中断，请重新安装。',
      EXTENSION_INSTALL_CANCELLED: '安装已取消。',
    })
</script>

<template>
  <div class="installation-list" data-testid="extension-installation-log">
    <NEmpty v-if="!jobs.length" :description="en ? 'No installation records' : '暂无安装记录'" />
    <article v-for="job in jobs" :key="job.id" class="installation-record" :data-installation-id="job.id" :data-status="job.status">
      <header>
        <strong>{{ job.name }}</strong><NTag size="small" :bordered="false" :type="job.status === 'failed' ? 'error' : 'default'">
          {{ statuses[job.status] }}
        </NTag>
      </header>
      <p class="installation-record__meta">
        {{ new Date(job.startedAt).toLocaleString(language) }} · {{ stages[job.stage] }}
      </p>
      <p v-if="job.error" role="status">
        {{ errors[job.error] ?? job.error }}
      </p>
      <details :open="job.status === 'failed' || job.status === 'running'">
        <summary>{{ en ? 'View log' : '查看日志' }}</summary>
        <ol>
          <li v-for="(entry, index) in job.entries" :key="index">
            <time>{{ new Date(entry.time).toLocaleTimeString(language) }}</time> {{ stages[entry.stage] }} · {{ messages[entry.message] ?? entry.message }}
          </li>
        </ol>
      </details>
      <NButton v-if="job.status === 'running' || job.status === 'review'" size="small" @click="emit('cancel', job.id)">
        {{ en ? 'Cancel installation' : '取消安装' }}
      </NButton>
    </article>
  </div>
</template>

<style scoped>
.installation-list { display: grid; gap: 16px; }
.installation-record { border-bottom: 1px solid var(--buddy-border-subtle); padding-bottom: 16px; font-size: 13px; overflow-wrap: anywhere; }
.installation-record header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.installation-record__meta { color: var(--buddy-text-secondary); font-size: 12px; }
.installation-record details { margin: 12px 0; }
.installation-record summary { cursor: pointer; }
.installation-record ol { list-style: none; padding: 0; line-height: 1.8; font-family: monospace; font-size: 11px; }
.installation-record time { color: var(--buddy-text-secondary); }
</style>

<script setup lang="ts">
import type { ExtensionReview } from '@buddy-shared/extensions/extensionApi'
import { Alert20Regular, Clock20Regular, Document20Regular, Globe20Regular } from '@vicons/fluent'
import { NButton, NModal } from 'naive-ui'
import { computed } from 'vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopPluginIcon from '@/shared/ui/icon/DesktopPluginIcon.vue'
import { extensionLabels } from '../extensionLabels'

const props = defineProps<{ review: ExtensionReview, language: string, busy: boolean }>()
const emit = defineEmits<{ cancel: [], install: [] }>()
const labels = computed(() => extensionLabels(props.language))
const english = computed(() => props.language === 'en-US')
const permissions = computed(() => {
  const { permissions } = props.review.manifest
  return [
    ...(permissions.windowEffects ? [{ key: 'windowEffects', icon: Alert20Regular, title: english.value ? 'Display window effects' : '显示窗口特效', description: english.value ? 'Draw over Lexora and receive typing activity. Typed text and keys are never shared.' : '在 Lexora 窗口绘制效果，接收对话输入活动；不会获取输入文字或按键。' }] : []),
    ...permissions.controls.map(target => ({ key: `controls:${target}`, icon: Alert20Regular, title: english.value ? 'Provide a reasoning control' : '提供思考等级控件', description: english.value ? 'After you select this style, display available levels and submit your selection.' : '由你选择启用后，展示可用等级并提交你的选择。' })),
    ...(permissions.notifications ? [{ key: 'notifications', icon: Alert20Regular, title: labels.value.notifications, description: english.value ? 'Show reminders in your system notification center.' : '通过系统通知向你发送提醒。' }] : []),
    ...(permissions.schedules ? [{ key: 'schedules', icon: Clock20Regular, title: english.value ? 'Run scheduled tasks' : '执行后台定时任务', description: english.value ? 'Continue running while Lexora is open, even when the plugin page is closed.' : 'Lexora 运行期间，关闭插件页面后仍可执行。' }] : []),
    ...(permissions.selectedResource === 'read' ? [{ key: 'selectedResource:read', icon: Document20Regular, title: labels.value.selected, description: english.value ? 'Read the content of files you select for this plugin.' : '读取你为此插件选中的文件内容。' }] : []),
    ...(permissions.localResources ? [{ key: 'localResources', icon: Document20Regular, title: english.value ? 'Read files and folders you select' : '读取你选择的文件和目录', description: english.value ? 'Choose files or folders in a system dialog. The plugin can read selected files and scan selected folders until you revoke access.' : '通过系统窗口选择文件或目录；插件可读取所选文件、扫描所选目录，授权保留到你撤销。' }] : []),
    ...(permissions.resourceExport ? [{ key: 'resourceExport', icon: Document20Regular, title: english.value ? 'Save files to a location you choose' : '保存文件到你选择的位置', description: english.value ? 'Each export opens a system save dialog. Reading a file does not grant permission to overwrite it.' : '每次导出都由你通过系统保存窗口选择目标；读取文件不会自动授予覆写权限。' }] : []),
    ...permissions.network.map(origin => ({ key: `network:${origin}`, icon: Globe20Regular, title: `${labels.value.network} ${origin}`, description: english.value ? 'Send requests to this website and read its responses.' : '向此网站发送请求并读取响应。' })),
  ]
})
const source = computed(() => props.review.development ? (english.value ? 'Development folder' : '开发目录') : props.review.source ? (english.value ? 'Lexora Marketplace' : 'Lexora 插件市场') : (english.value ? 'Local package' : '本地插件包'))
const sharesFiles = computed(() => (props.review.manifest.permissions.selectedResource === 'read' || props.review.manifest.permissions.localResources) && props.review.manifest.permissions.network.length > 0)
</script>

<template>
  <NModal
    show
    preset="card"
    :title="english ? (review.currentVersion ? 'Update plugin' : 'Install plugin') : (review.currentVersion ? '更新插件' : '安装插件')"
    class="extension-install-review"
    :mask-closable="!busy"
    :closable="!busy"
    :close-on-esc="!busy"
    data-testid="extension-install-review"
    @update:show="value => { if (!value) emit('cancel') }"
  >
    <div class="extension-install-review__identity">
      <span class="extension-install-review__icon" aria-hidden="true">
        <DesktopPluginIcon :src="review.iconUrl" :size="28" />
      </span>
      <div class="extension-install-review__heading">
        <h2>{{ review.manifest.name }}</h2>
        <p class="extension-install-review__meta">
          <span>{{ source }}</span>
          <span class="extension-install-review__version">
            <template v-if="review.currentVersion">{{ review.currentVersion }} → </template>{{ review.manifest.version }}
          </span>
        </p>
      </div>
    </div>
    <p v-if="review.manifest.description" class="extension-install-review__description">
      {{ review.manifest.description }}
    </p>
    <section class="extension-install-review__permissions">
      <h3>{{ labels.permissions }}</h3>
      <ul v-if="permissions.length">
        <li v-for="permission in permissions" :key="permission.key">
          <DesktopIcon class="extension-install-review__permission-icon" :component="permission.icon" :size="18" aria-hidden="true" />
          <div>
            <div class="extension-install-review__permission-title">
              <span>{{ permission.title }}</span>
              <span v-if="review.currentVersion && review.addedPermissions.includes(permission.key)" class="extension-install-review__new">{{ english ? 'New' : '新增' }}</span>
            </div>
            <p>{{ permission.description }}</p>
          </div>
        </li>
      </ul>
      <p v-else class="extension-install-review__muted">
        {{ labels.none }}
      </p>
      <p v-if="review.currentVersion && !review.addedPermissions.length" class="extension-install-review__muted extension-install-review__unchanged">
        {{ labels.noAdded }}
      </p>
    </section>
    <section v-if="Object.keys(review.manifest.dependencies).length" class="extension-install-review__dependencies">
      <h3>{{ labels.dependencies }}</h3>
      <p v-for="(range, id) in review.manifest.dependencies" :key="id">
        {{ id }} <span>{{ range }}</span>
      </p>
    </section>
    <p class="extension-install-review__trust">
      {{ english ? 'Only install plugins from sources you trust.' : '请确认你信任此插件的来源。' }}
      <template v-if="sharesFiles">
        {{ english ? 'This plugin can send selected file content to the listed websites.' : '此插件可以向上述网站发送已授权读取的文件内容。' }}
      </template>
    </p>
    <template #footer>
      <div class="extension-install-review__actions">
        <NButton :disabled="busy" @click="emit('cancel')">
          {{ labels.cancel }}
        </NButton>
        <NButton type="primary" :loading="busy" data-testid="extension-confirm-install" @click="emit('install')">
          {{ review.currentVersion ? labels.update : labels.confirm }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
:global(.extension-install-review) {
  width: min(500px, calc(100vw - 32px));
  max-height: calc(100dvh - 48px);
  border-radius: 12px;
}
.extension-install-review {
  :deep(.n-card-header) { padding: 20px 24px 0; }
  :deep(.n-card-header__main) { font-size: 16px; font-weight: 600; }
  :deep(.n-card__content) { overflow-y: auto; padding: 24px; }
  :deep(.n-card__footer) { padding: 16px 24px; border-top: 1px solid var(--buddy-border-subtle); }
}
.extension-install-review__identity { display: flex; align-items: center; gap: 14px; }
.extension-install-review__icon { display: grid; flex: 0 0 44px; width: 44px; height: 44px; place-items: center; border-radius: 10px; color: var(--buddy-nav-foreground); background: var(--buddy-nav-selected); }
.extension-install-review__heading { min-width: 0; }
.extension-install-review__heading h2 { margin: 0; color: var(--buddy-text-strong); font-size: 18px; font-weight: 600; line-height: 1.45; overflow-wrap: anywhere; }
.extension-install-review__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 5px 0 0; color: var(--buddy-text-secondary); font-size: 12px; line-height: 1.5; }
.extension-install-review__version { padding: 0 6px; border: 1px solid var(--buddy-border-subtle); border-radius: 4px; font-variant-numeric: tabular-nums; }
.extension-install-review__description { margin: 16px 0 0; color: var(--buddy-text-secondary); font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; }
.extension-install-review__permissions { margin-top: 24px; }
.extension-install-review h3 { margin: 0 0 12px; color: var(--buddy-text-strong); font-size: 13px; font-weight: 600; line-height: 1.5; }
.extension-install-review__permissions ul { display: grid; gap: 16px; margin: 0; padding: 0; list-style: none; }
.extension-install-review__permissions li { display: grid; grid-template-columns: 18px minmax(0, 1fr); align-items: start; gap: 10px; }
.extension-install-review__permission-icon { margin-top: 2px; color: var(--buddy-text-secondary); }
.extension-install-review__permission-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--buddy-text-primary); font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.extension-install-review__permissions li p { margin: 2px 0 0; color: var(--buddy-text-secondary); font-size: 12px; line-height: 1.6; }
.extension-install-review__new { padding: 0 5px; border-radius: 4px; color: var(--buddy-nav-foreground); background: var(--buddy-nav-selected); font-size: 11px; }
.extension-install-review__muted { margin: 0; color: var(--buddy-text-secondary); font-size: 12px; line-height: 1.6; }
.extension-install-review__unchanged { margin-top: 12px; }
.extension-install-review__dependencies { margin-top: 24px; }
.extension-install-review__dependencies p { margin: 4px 0 0; color: var(--buddy-text-primary); font-size: 12px; overflow-wrap: anywhere; }
.extension-install-review__dependencies span { color: var(--buddy-text-secondary); }
.extension-install-review__trust { margin: 24px 0 0; color: var(--buddy-text-secondary); font-size: 12px; line-height: 1.6; }
.extension-install-review__actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>

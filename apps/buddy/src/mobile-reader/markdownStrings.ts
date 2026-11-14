import { reactive } from 'vue'

const en = {
  'common.copy': 'Copy',
  'common.selectCopy': 'Select all (copy)',
  'common.copied': 'Copied',
  'common.decrease': 'Decrease',
  'common.reset': 'Reset',
  'common.increase': 'Increase',
  'common.expand': 'Expand',
  'common.collapse': 'Collapse',
  'common.preview': 'Preview',
  'common.source': 'Source',
  'common.export': 'Export',
  'common.open': 'Open',
  'common.minimize': 'Minimize',
  'common.zoomIn': 'Zoom in',
  'common.zoomOut': 'Zoom out',
  'common.resetZoom': 'Reset zoom',
  'image.loadError': 'Image failed to load',
  'image.loading': 'Loading image…',
}
const zh: Record<keyof typeof en, string> = {
  'common.copy': '复制',
  'common.selectCopy': '全选（复制）',
  'common.copied': '已复制',
  'common.decrease': '缩小',
  'common.reset': '重置',
  'common.increase': '放大',
  'common.expand': '展开',
  'common.collapse': '折叠',
  'common.preview': '预览',
  'common.source': '源代码',
  'common.export': '导出',
  'common.open': '打开',
  'common.minimize': '最小化',
  'common.zoomIn': '放大',
  'common.zoomOut': '缩小',
  'common.resetZoom': '重置缩放',
  'image.loadError': '图片加载失败',
  'image.loading': '正在加载图片…',
}

export const markdownStrings = reactive({ ...zh })
export function setMarkdownLanguage(language: string) {
  Object.assign(markdownStrings, language === 'en' ? en : zh)
}

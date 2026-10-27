import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { defineConfig } from 'vitepress'
import { downloadUrl, repositoryUrl } from './productLinks'
import { pageSeo } from './seo'

const websiteBasePath = (process.env.WEBSITE_BASE_PATH ?? '').replace(/^\/+|\/+$/g, '')
const websiteBase = websiteBasePath ? `/${websiteBasePath}/` : '/'
const websiteOrigin = new URL(process.env.WEBSITE_ORIGIN || 'https://uselexora.app').origin
const websiteUrl = new URL(websiteBase, websiteOrigin).href

const guideGroups = [
  {
    zh: '开始使用',
    en: 'Getting started',
    items: [
      { slug: 'what-is-lexora', zh: '认识 Lexora', en: 'Meet Lexora' },
      { slug: 'quick-start', zh: '第一个任务', en: 'Your first task' },
      { slug: 'settings-and-models', zh: '连接模型', en: 'Connect a model' },
    ],
  },
  {
    zh: '日常工作',
    en: 'Everyday work',
    items: [
      { slug: 'ai-chat', zh: '任务与对话', en: 'Tasks and conversations' },
      { slug: 'files-and-spaces', zh: '文件与空间', en: 'Files and spaces' },
      { slug: 'companions', zh: '伙伴与协作', en: 'Companions and collaboration' },
    ],
  },
  {
    zh: '扩展工作方式',
    en: 'Extend your workflow',
    items: [
      { slug: 'plugins', zh: '使用与制作插件', en: 'Using and creating plugins' },
      { slug: 'skills-and-mcp', zh: 'Skills 与 MCP', en: 'Skills and MCP' },
      { slug: 'automations', zh: '自动化', en: 'Automations' },
    ],
  },
  {
    zh: '管理与排错',
    en: 'Manage and troubleshoot',
    items: [
      { slug: 'permissions', zh: '执行权限', en: 'Execution permissions' },
      { slug: 'data-and-backup', zh: '数据与备份', en: 'Data and backups' },
      { slug: 'troubleshooting', zh: '常见问题', en: 'Troubleshooting' },
    ],
  },
]

const pluginGroups = [
  {
    zh: '开始',
    en: 'Getting started',
    items: [
      { slug: '', zh: '插件开发', en: 'Plugin development' },
      { slug: 'quick-start', zh: '第一个插件', en: 'Your first plugin' },
    ],
  },
  {
    zh: '基础',
    en: 'Fundamentals',
    items: [
      { slug: 'concepts', zh: '核心概念', en: 'Core concepts' },
      { slug: 'permissions', zh: '权限与兼容性', en: 'Permissions and compatibility' },
    ],
  },
  {
    zh: '能力指南',
    en: 'Capabilities',
    items: [
      { slug: 'views', zh: '视图与交互', en: 'Views and interaction' },
      { slug: 'files', zh: '文件与文档', en: 'Files and documents' },
      { slug: 'references', zh: '引用与来源定位', en: 'References and source reveal' },
      { slug: 'agent', zh: 'Agent 能力', en: 'Agent capabilities' },
      { slug: 'settings', zh: '设置与状态', en: 'Settings and state' },
      { slug: 'appearance', zh: '主题与外观', en: 'Themes and appearance' },
      { slug: 'workers', zh: '依赖与计算', en: 'Dependencies and computation' },
    ],
  },
  {
    zh: '参考与交付',
    en: 'Reference and distribution',
    items: [
      { slug: 'api', zh: 'API 参考', en: 'API reference' },
      { slug: 'distribution', zh: '构建与分发', en: 'Build and distribute' },
    ],
  },
]

function docSidebars(locale: 'zh' | 'en') {
  const prefix = locale === 'en' ? '/en' : ''
  const groups = (items: typeof guideGroups, section: string) => items.map(group => ({
    text: group[locale],
    items: group.items.map(page => ({ text: page[locale], link: `${prefix}/${section}/${page.slug}` })),
  }))
  return {
    [`${prefix}/guide/`]: groups(guideGroups, 'guide'),
    [`${prefix}/plugins/`]: groups(pluginGroups, 'plugins'),
  }
}

export default defineConfig({
  title: 'Lexora',
  description: 'Lexora 是在真实桌面实践中自我演化的个人 AI Agent。它不局限于代码助手的角色，也能陪你整理资料、打磨作品、安排日常。你说出目标，它持续推进，让文字成为工作、创作与生活的起点。',
  base: websiteBase,
  cleanUrls: true,
  appearance: true,
  outDir: '../dist',
  cacheDir: '../.vitepress/cache',
  sitemap: { hostname: websiteUrl },
  transformPageData(page) {
    if (page.relativePath !== '404.md')
      page.frontmatter.head = [...(page.frontmatter.head ?? []), ...pageSeo(page, websiteUrl)]
  },
  transformHead({ pageData }) {
    if (pageData.relativePath === '404.md')
      return [['meta', { name: 'robots', content: 'noindex' }]]
  },
  async buildEnd({ outDir }) {
    await writeFile(join(outDir, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${websiteUrl}sitemap.xml\n`)
  },
  head: [
    ['link', { rel: 'icon', type: 'image/png', sizes: '512x512', href: `${websiteBase}favicon.png` }],
    ['meta', { name: 'theme-color', media: '(prefers-color-scheme: light)', content: '#293f7d' }],
    ['meta', { name: 'theme-color', media: '(prefers-color-scheme: dark)', content: '#121d39' }],
    ['meta', { property: 'og:site_name', content: 'Lexora' }],
    ['meta', { property: 'og:type', content: 'website' }],
  ],
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      themeConfig: {
        nav: [
          { text: '如何工作', link: '/#workspace' },
          { text: '使用指南', link: '/guide/quick-start' },
          { text: '插件开发', link: '/plugins/' },
          { text: '下载 Lexora', link: downloadUrl },
        ],
        sidebar: docSidebars('zh'),
        outline: { label: '本页内容', level: [2, 3] },
        docFooter: { prev: '上一篇', next: '下一篇' },
        returnToTopLabel: '回到顶部',
        sidebarMenuLabel: '目录',
        darkModeSwitchLabel: '外观',
        lightModeSwitchTitle: '切换至亮色外观',
        darkModeSwitchTitle: '切换至深色外观',
      },
    },
    en: {
      label: 'English',
      lang: 'en-US',
      description: 'Lexora is a personal AI agent that evolves through hands-on work on your desktop. Beyond coding, it helps you organize research, refine creative projects, and plan everyday activities. Tell it what you want to accomplish, and it keeps working toward that goal, making words the starting point for work, creativity, and everyday life.',
      themeConfig: {
        nav: [
          { text: 'How it works', link: '/en/#workspace' },
          { text: 'Guide', link: '/en/guide/quick-start' },
          { text: 'Plugin development', link: '/en/plugins/' },
          { text: 'Get Lexora', link: downloadUrl },
        ],
        sidebar: docSidebars('en'),
        outline: { label: 'On this page', level: [2, 3] },
      },
    },
  },
  themeConfig: {
    aside: true,
    logo: '/favicon.png',
    search: {
      provider: 'local',
      options: {
        locales: {
          root: {
            translations: {
              button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
              modal: { noResultsText: '没有找到相关内容', resetButtonTitle: '清除搜索', footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' } },
            },
          },
        },
      },
    },
    socialLinks: [{ icon: 'github', link: repositoryUrl }],
  },
})

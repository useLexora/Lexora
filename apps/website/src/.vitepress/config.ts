import process from 'node:process'
import { defineConfig } from 'vitepress'
import { downloadUrl, repositoryUrl } from './productLinks'

const websiteBasePath = (process.env.WEBSITE_BASE_PATH ?? '').replace(/^\/+|\/+$/g, '')
const websiteBase = websiteBasePath ? `/${websiteBasePath}/` : '/'

const guides = [
  { slug: 'what-is-lexora', zh: '认识 Lexora', en: 'Meet Lexora' },
  { slug: 'quick-start', zh: '第一个任务', en: 'Your first task' },
  { slug: 'ai-chat', zh: '与 Lexora 一起做事', en: 'Working with Lexora' },
  { slug: 'files-and-spaces', zh: '文件与空间', en: 'Files and spaces' },
  { slug: 'automations', zh: '自动化', en: 'Automations' },
  { slug: 'settings-and-models', zh: '模型与工具', en: 'Models and tools' },
]

export default defineConfig({
  title: 'Lexora',
  description: '想你所想，行你所行。在真实桌面实践中自我演化的个人 AI Agent，调度本地工具与文件，让文字成为工作、创作与生活的起点。',
  base: websiteBase,
  cleanUrls: true,
  appearance: 'dark',
  outDir: '../dist',
  cacheDir: '../.vitepress/cache',
  head: [
    ['link', { rel: 'icon', type: 'image/png', sizes: '512x512', href: `${websiteBase}favicon.png` }],
    ['meta', { name: 'theme-color', content: '#111724' }],
    ['meta', { property: 'og:site_name', content: 'Lexora' }],
    ['meta', { property: 'og:type', content: 'website' }],
  ],
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      themeConfig: {
        nav: [
          { text: '探索', link: '/#playground' },
          { text: '使用指南', link: '/guide/quick-start' },
          { text: '下载 Lexora', link: downloadUrl },
        ],
        sidebar: [{
          text: '你的 Lexora 工作台',
          items: guides.map(guide => ({ text: guide.zh, link: `/guide/${guide.slug}` })),
        }],
        outline: { label: '本页内容' },
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
      description: 'Think alongside you. Act on your intent. A self-evolved, sovereign desktop AI agent crafted to make words the starting point for work, creativity, and everyday life.',
      themeConfig: {
        nav: [
          { text: 'Explore', link: '/en/#playground' },
          { text: 'Guide', link: '/en/guide/quick-start' },
          { text: 'Get Lexora', link: downloadUrl },
        ],
        sidebar: [{
          text: 'Your Lexora workspace',
          items: guides.map(guide => ({ text: guide.en, link: `/en/guide/${guide.slug}` })),
        }],
      },
    },
  },
  themeConfig: {
    aside: false,
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

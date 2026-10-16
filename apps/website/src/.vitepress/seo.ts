import type { HeadConfig, PageData } from 'vitepress'
import { repositoryUrl } from './productLinks'

// Repository topics reflected in the website's content. These describe the
// site in JSON-LD; they are not a meta-keywords ranking mechanism.
const websiteTopics = [
  'ai-agent',
  'desktop-agent',
  'autonomous-agents',
  'multi-agent',
  'mcp',
  'skills',
  'plugins',
  'local-ai',
  'sandbox',
  'desktop-pet',
  'linux-desktop',
  'archlinux',
  'agent-loop',
  'pi',
  'pi-agent',
  'rust',
  'typescript',
]

export function pageSeo(page: PageData, siteUrl: string): HeadConfig[] {
  const english = page.relativePath.startsWith('en/')
  const localPath = page.relativePath.replace(/^en\//, '').replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '')
  const url = (path: string) => new URL(path, siteUrl).href
  const canonical = url(`${english ? 'en/' : ''}${localPath}`)
  const home = localPath === ''
  const title = page.frontmatter.socialTitle || `${page.title} | Lexora`
  const image = url(`landing/share-${english ? 'en' : 'zh'}.png`)
  const imageAlt = english
    ? 'Lexora coordinates DeepSeek, Claude, ChatGPT, and NPCs to keep working toward your goals'
    : 'Lexora 围绕用户目标调度大肥鱼、小克、小白与 NPC 持续工作'

  const head: HeadConfig[] = [
    ['link', { rel: 'canonical', href: canonical }],
    ['link', { rel: 'alternate', hreflang: 'zh-CN', href: url(localPath) }],
    ['link', { rel: 'alternate', hreflang: 'en-US', href: url(`en/${localPath}`) }],
    ['link', { rel: 'alternate', hreflang: 'x-default', href: url(localPath) }],
    ['meta', { property: 'og:url', content: canonical }],
    ['meta', { property: 'og:title', content: title }],
    ['meta', { property: 'og:description', content: page.description }],
    ['meta', { property: 'og:locale', content: english ? 'en_US' : 'zh_CN' }],
    ['meta', { property: 'og:locale:alternate', content: english ? 'zh_CN' : 'en_US' }],
    ['meta', { property: 'og:image', content: image }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    ['meta', { property: 'og:image:alt', content: imageAlt }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: title }],
    ['meta', { name: 'twitter:description', content: page.description }],
    ['meta', { name: 'twitter:image', content: image }],
    ['meta', { name: 'twitter:image:alt', content: imageAlt }],
  ]

  const breadcrumbs = [
    { name: 'Lexora', item: url(english ? 'en/' : '') },
    ...localPath === 'guide/what-is-lexora'
      ? []
      : [{ name: english ? 'Guide' : '使用指南', item: url(`${english ? 'en/' : ''}guide/what-is-lexora`) }],
    { name: page.title, item: canonical },
  ]
  const structuredData = home
    ? {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        '@id': `${siteUrl}#website`,
        'name': 'Lexora',
        'url': siteUrl,
        'description': page.description,
        'inLanguage': ['zh-CN', 'en-US'],
        'sameAs': [repositoryUrl],
        'keywords': websiteTopics,
      }
    : {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        'itemListElement': breadcrumbs.map((item, index) => ({
          '@type': 'ListItem',
          'position': index + 1,
          ...item,
        })),
      }
  head.push(['script', { type: 'application/ld+json' }, JSON.stringify(structuredData).replace(/</g, '\\u003c')])
  return head
}

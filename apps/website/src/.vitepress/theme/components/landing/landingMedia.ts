const scenes = [
  {
    id: 'workspace',
    guide: 'files-and-spaces',
    width: 1504,
    height: 1018,
    mobilePosition: undefined,
    zh: { tab: '文件与多分屏', title: '任务、文件与成果，同时打开。', description: '从本地文件树管理项目，把多个任务拖入分屏，在旁边阅读文件与预览成果。每个任务保留自己的上下文与输入区。', caption: '应用截图 · 使用示例资料展示分屏与文件预览', alt: '两个任务的独立对话与输入区并排打开，右侧显示文件预览，使用示例资料' },
    en: { tab: 'Files & split views', title: 'Tasks, files, and results in view.', description: 'Manage a project in the local file tree, drag tasks into split views, and read files or preview outputs beside them. Each task keeps its own context and composer.', caption: 'App screenshot · Example content showing split views and file previews', alt: 'Two separate task conversations and composers beside a file preview, using example content' },
  },
  {
    id: 'references',
    guide: 'ai-chat',
    width: 1176,
    height: 968,
    mobilePosition: '0% 100%',
    zh: { tab: '带着来源引用', title: '选中这一段，接着说。', description: '引用对话、文件内容，或用内置浏览器拾取网页元素。把需要修改或核对的部分带到输入框，保留来源，继续提要求。', caption: '应用截图 · 示例资料中的文件引用', alt: '文件中的一段内容被引用到输入框，引用卡片保留文件来源，使用示例资料' },
    en: { tab: 'Quote with context', title: 'Quote a passage and keep going.', description: 'Quote a conversation or file, or pick a page element in the built-in browser. Bring the part you want to change or check into the composer with its source attached.', caption: 'App screenshot · A file quote using example content', alt: 'A file passage quoted in the composer, with its source attached, using example content' },
  },
  {
    id: 'collaboration',
    guide: 'companions',
    width: 2539,
    height: 1764,
    mobilePosition: undefined,
    zh: { tab: '具名伙伴协作', title: '谁在做什么，看得清楚。', description: '把多个伙伴加入同一个任务，由主角统筹，或点名伙伴接手。这里的大肥鱼与小白是公开参与对话的伙伴；NPC 则负责主角派出的独立子任务。', caption: '大肥鱼写故事，小白接手动画', alt: 'Lexora 任务中的具名协作树与回复：Lexora 协调，大肥鱼写故事，小白制作动画' },
    en: { tab: 'Named collaboration', title: 'See who is working on what.', description: 'Add companions to one task. Let the lead coordinate or address a companion by name. These companions participate in the shared conversation; NPCs handle separate subtasks delegated by the lead.', caption: 'Chinese UI: 大肥鱼 writes the story; 小白 takes on the animation', alt: 'Task in the Chinese Lexora interface, showing named collaboration and replies from Lexora, 大肥鱼, and 小白' },
  },
  {
    id: 'schedules',
    guide: 'automations',
    width: 1424,
    height: 968,
    mobilePosition: undefined,
    zh: { tab: '按计划继续工作', title: '重复的事，提前安排好。', description: '把整理工作记录、汇总资料等任务设为计划，先手动运行一次，再查看每次执行的记录和成果。应用保持运行、电脑保持唤醒时，按约定时间推进。', caption: '周五回顾的计划设置与执行时间预览', alt: '自动化计划编辑器中的周五回顾、提示词与未来执行时间' },
    en: { tab: 'Scheduled work', title: 'Make room for recurring work.', description: 'Schedule summaries and research updates. Try a manual run first, then inspect each run and its outputs. Schedules execute locally while the app is running and your computer is awake.', caption: 'Friday review settings and upcoming execution times', alt: 'Automation editor with the Friday review prompt and upcoming execution times' },
  },
] as const

export function getProductScreenshots(english: boolean) {
  const locale = english ? 'en' : 'zh'
  return scenes.map(scene => ({
    id: scene.id,
    guide: `${english ? '/en' : ''}/guide/${scene.guide}`,
    src: `/landing/screenshots/${scene.id}-${scene.id === 'collaboration' ? 'zh' : locale}.webp`,
    width: scene.width,
    height: scene.height,
    mobilePosition: scene.mobilePosition,
    mobileSrc: scene.id === 'collaboration' ? '/landing/screenshots/collaboration-detail.webp' : undefined,
    mobileWidth: scene.id === 'collaboration' ? 1080 : undefined,
    mobileHeight: scene.id === 'collaboration' ? 270 : undefined,
    ...scene[locale],
  }))
}

export const landingFilm = {
  src: '',
  poster: '/landing/film-poster.webp',
}

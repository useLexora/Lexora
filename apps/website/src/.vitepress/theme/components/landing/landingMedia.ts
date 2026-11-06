const scenes = [
  {
    id: 'overview',
    guide: 'quick-start',
    width: 1760,
    height: 1080,
    icon: 'split',
    zh: { src: 'readme-overview-zh.webp', tab: '整个工作台', title: '聊到哪，就做到哪。', description: '写作提纲、配图讨论与开篇草稿并排打开。不用在窗口之间来回找，文件和进展就在任务旁。', caption: '实际工作台截图 · 写作、配图与草稿分屏', alt: 'Lexora 完整工作台：三个写作任务分屏显示，右侧预览山坡小屋插画' },
    en: { src: 'readme-overview-en.webp', tab: 'The workspace', title: 'Keep the conversation and the work together.', description: 'A story outline, illustration notes, and an opening draft, side by side. Files and progress stay beside the task, not scattered across windows.', caption: 'App screenshot · Writing, illustration, and drafting in split views', alt: 'The Lexora workspace with three writing tasks in split views and a hillside cottage illustration beside them' },
  },
  {
    id: 'local-image',
    guide: 'local-models',
    icon: 'image',
    width: 1760,
    height: 1000,
    zh: { src: 'readme-local-image-zh.webp', tab: '本地对话与生图', title: '从本地对话，到本地生成。', description: 'Qwen3.5-9B 理解需求、调用工具，Z-Image 在本机生成图片。成果直接在任务旁预览，继续描述想调整的地方。模型与引擎需通过插件另行准备。', caption: '实际任务截图 · Qwen3.5-9B 与 Z-Image 生成橘白小猫', alt: 'Qwen3.5-9B 的任务对话、图片产物卡片与右侧正常显示的小猫插画' },
    en: { src: 'readme-local-image-en.webp', tab: 'Local chat and images', title: 'From local chat to local generation.', description: 'Qwen3.5-9B interprets the request and calls a tool. Z-Image generates the picture locally, ready to preview beside the task. Models and engines are prepared separately through a plugin.', caption: 'Recorded task · Qwen3.5-9B and Z-Image generate an orange-and-white kitten', alt: 'An English Qwen3.5-9B task with an image output card and the generated kitten illustration beside it' },
  },
  {
    id: 'documents',
    guide: 'documents',
    icon: 'file',
    width: 1760,
    height: 1000,
    zh: { src: 'readme-office-zh.webp', tab: '文档与作品', title: '把资料整理成能交付的文档。', description: '通过 Office 插件处理文档、表格、演示文稿和 PDF。把任务与文件并排打开，引用需要修改的内容，检查保存后的成果。', caption: 'Office 插件 · 案例讨论与四种格式的文档列表', alt: '左侧讨论案例报告，右侧 Office 插件显示 Word、Excel、PowerPoint 和 PDF 文件' },
    en: { src: 'readme-office-en.webp', tab: 'Documents and work', title: 'Turn research into documents you can share.', description: 'Use the Office plugin for documents, spreadsheets, presentations, and PDFs. Keep the task beside the file, quote what needs changing, and check the saved result.', caption: 'Office plugin · English task with Chinese plugin UI', alt: 'An English report-writing task beside the Office plugin’s Chinese interface and a list of Word, Excel, PowerPoint, and PDF files' },
  },
  {
    id: 'references',
    guide: 'ai-chat',
    icon: 'chat',
    width: 1176,
    height: 968,
    zh: { src: 'references-zh.webp', tab: '资料与引用', title: '带着来源，继续讨论。', description: '引用对话、文件内容或网页元素，把需要核对的部分带进任务。查资料时保留来源，改稿时指明段落，不必每次从头解释。', caption: '应用截图 · 示例资料中的文件选区引用', alt: '文件中的一段内容被引用到输入框，引用卡片保留文件来源' },
    en: { src: 'references-en.webp', tab: 'Research and quotes', title: 'Keep the source in the conversation.', description: 'Quote a conversation, file, or browser element to bring the relevant part into a task. Keep sources with research and point to the passage you want revised, without starting over.', caption: 'App screenshot · A file selection quoted from example material', alt: 'A file passage quoted in the composer with its source attached' },
  },
  {
    id: 'projects',
    guide: 'files-and-spaces',
    icon: 'code',
    width: 3318,
    height: 1817,
    zh: { src: 'readme-project-zh.webp', tab: '项目与代码', title: '查问题、改代码，再核对结果。', description: '读取项目文件、执行命令、检查改动，必要时让伙伴分工审查。把浏览器与任务放在一起，对照项目和拉取请求继续工作。', caption: '实际任务截图 · 项目修复、子任务记录与内置浏览器', alt: '项目修复任务显示工具记录和子任务树，右侧内置浏览器打开 GitHub 项目' },
    en: { src: 'readme-project-zh.webp', tab: 'Projects and code', title: 'Investigate, edit, and check the result.', description: 'Read project files, run commands, and inspect changes. Bring in companions for independent review and keep a browser beside the task to check the project and pull requests.', caption: 'Recorded task · Project work and the built-in browser · Chinese UI', alt: 'A project task in the Chinese interface showing tool records, subtasks, and a GitHub repository in the built-in browser' },
  },
] as const

export function getProductScreenshots(english: boolean) {
  const locale = english ? 'en' : 'zh'
  return scenes.map(scene => ({
    id: scene.id,
    icon: scene.icon,
    guide: `${english ? '/en' : ''}/guide/${scene.guide}`,
    width: scene.width,
    height: scene.height,
    ...scene[locale],
    src: `/landing/screenshots/${scene[locale].src}`,
  }))
}

export const landingFilm = {
  src: '',
  poster: '/landing/film-poster.webp',
}

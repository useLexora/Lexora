const scenes = [
  {
    id: 'tasks',
    zh: { title: '让想象，有个样子', description: '聊聊想法，试试风格，把生成的图片放大来看。', alt: 'Lexora 生图任务：两张赛博朋克角色图，右侧打开星月法师大图预览' },
    en: { title: 'Give your imagination a shape', description: 'Talk through an idea, explore a style, and take a closer look at the images.', alt: 'Lexora image task with two cyberpunk character artworks and a large celestial mage preview' },
  },
  {
    id: 'artifacts',
    zh: { title: '文件，就在手边', description: '一边继续对话，一边打开提纲、清单和项目文件。', alt: 'Lexora 深色工作台：左侧任务对话，右侧打开城市漫步 Markdown 提纲' },
    en: { title: 'Your files, right beside you', description: 'Keep the conversation going with an outline or project file open.', alt: 'Lexora dark workspace with a conversation and a Markdown outline open side by side' },
  },
  {
    id: 'automations',
    zh: { title: '给重复的事，安排一个时间', description: '把提示词、工作空间和运行计划放在一起。', alt: 'Lexora 自动化编辑界面：每周五汇总工作记录的提示词、空间和时间计划' },
    en: { title: 'A time for the recurring things', description: 'Bring the prompt, workspace, and schedule together.', alt: 'Lexora automation editor with a weekly wrap-up prompt, workspace, and schedule' },
  },
  {
    id: 'models',
    zh: { title: '用你顺手的模型', description: '接入 OpenAI Codex、Anthropic、DeepSeek，按自己的习惯选择。', alt: 'Lexora 深色模型设置页，展示 OpenAI Codex、Anthropic 和 DeepSeek 三个模型服务' },
    en: { title: 'The models you feel at home with', description: 'Connect OpenAI Codex, Anthropic, and DeepSeek. Choose what works for you.', alt: 'Lexora dark model settings showing OpenAI Codex, Anthropic, and DeepSeek services' },
  },
] as const

export function getProductScreenshots(english: boolean) {
  const locale = english ? 'en' : 'zh'
  return scenes.map(scene => ({
    id: scene.id,
    src: `/landing/screenshots/${scene.id}-${locale}.webp`,
    width: 1600,
    height: 1000,
    ...scene[locale],
  }))
}

import type { InjectionKey, Ref } from 'vue'
import { computed, inject } from 'vue'

export const readerLanguageKey: InjectionKey<Readonly<Ref<string>>> = Symbol('reader-language')

const en = {
  messageActions: 'Message actions',
  copied: 'Copied',
  copyMessage: 'Copy message',
  branch: 'Branch from here',
  more: 'More message actions',
  failed: 'Failed',
  done: 'Done',
  callDetails: 'Call details',
  copyDetails: 'Copy call details',
  loadingOutput: 'Loading input and output…',
  noOutput: 'Completed without text output',
  retry: 'Retry',
  viewOutput: 'View input and output',
  openFull: 'Open full content',
  replying: 'Replying',
  interrupted: 'This reply did not complete',
  truncated: 'This preview is incomplete. Open the saved content for full details.',
  loadingSaved: 'Loading saved content…',
  viewFull: 'View full content',
  previewSaveShare: 'Preview, save or share',
  messages: 'Conversation messages',
  latest: 'Jump to latest',
  retryTranscript: 'Execution details unavailable · Retry',
  empty: 'Messages will appear here',
}
const zh: Record<keyof typeof en, string> = {
  messageActions: '消息操作',
  copied: '已复制',
  copyMessage: '复制消息',
  branch: '从这里继续',
  more: '更多消息操作',
  failed: '失败',
  done: '完成',
  callDetails: '调用详情',
  copyDetails: '复制调用详情',
  loadingOutput: '正在读取参数与输出…',
  noOutput: '调用已完成，没有文本输出',
  retry: '重试',
  viewOutput: '查看参数与输出',
  openFull: '打开完整内容',
  replying: '正在回复',
  interrupted: '这次回复未完成',
  truncated: '消息预览不完整，详情以已保存内容为准。',
  loadingSaved: '正在读取已保存内容…',
  viewFull: '查看完整内容',
  previewSaveShare: '预览、保存或分享',
  messages: '对话消息',
  latest: '回到最新',
  retryTranscript: '执行过程暂未载入 · 重试',
  empty: '消息将在这里显示',
}

export function useReaderStrings(source?: Readonly<Ref<string>>) {
  const language = source ?? inject(readerLanguageKey)
  return computed(() => language?.value === 'en' ? en : zh)
}

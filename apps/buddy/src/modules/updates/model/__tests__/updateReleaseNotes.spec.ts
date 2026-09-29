import { expect, it } from 'vitest'
import { updateReleaseHighlights } from '../updateReleaseNotes'

it('shows a bounded plain-text excerpt without loading Markdown images or executing release content', () => {
  expect(updateReleaseHighlights('## Highlights\n<!-- private note -->\n- **Restore tasks**\n- [Fix files](https://example.invalid)\n![image](https://example.invalid/pixel)\n```sh\ncommand\n```\n- Keep settings\n- More changes')).toEqual(['Restore tasks', 'Fix files', 'Keep settings'])
  expect(updateReleaseHighlights('- refactor: 事件嵌入服务架构 by @shanyuhai123 in https://github.com/useLexora/Lexora/pull/216\n- feat(buddy): 新增新任务默认权限设置 by @QAyong in https://github.com/useLexora/Lexora/pull/213\n- fix!: 修复升级流程 (#219)\n**Full Changelog**: https://github.com/useLexora/Lexora/compare/v0.9.3...v0.9.4')).toEqual([
    '事件嵌入服务架构',
    '新增新任务默认权限设置',
    '修复升级流程',
  ])
  expect(updateReleaseHighlights('')).toEqual([])
  expect(updateReleaseHighlights(`- ${'x'.repeat(10000)}`)[0]?.length).toBe(400)
})

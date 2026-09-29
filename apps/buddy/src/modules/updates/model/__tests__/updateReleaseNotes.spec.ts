import { expect, it } from 'vitest'
import { updateReleaseHighlights } from '../updateReleaseNotes'

it('shows a bounded plain-text excerpt without loading Markdown images or executing release content', () => {
  expect(updateReleaseHighlights('## Highlights\n<!-- private note -->\n- **Restore tasks**\n- [Fix files](https://example.invalid)\n![image](https://example.invalid/pixel)\n```sh\ncommand\n```\n- Keep settings\n- More changes')).toEqual(['Restore tasks', 'Fix files', 'Keep settings'])
  expect(updateReleaseHighlights('')).toEqual([])
  expect(updateReleaseHighlights(`- ${'x'.repeat(10000)}`)[0]?.length).toBe(400)
})

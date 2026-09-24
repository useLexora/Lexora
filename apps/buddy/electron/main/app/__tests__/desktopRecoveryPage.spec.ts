import { describe, expect, it } from 'vitest'
import { readRecoveryAction, recoveryPage } from '../desktopRecoveryPage'
import { describeDesktopStartupFailure } from '../desktopStartupFailure'

describe('isolated recovery page', () => {
  it('escapes diagnostic text and exposes only fixed actions without scripts or external resources', () => {
    const options = describeDesktopStartupFailure(new Error('fixture'), 'en-US')
    options.message = '<script>unsafe()</script>'
    options.recovery.fields.push({ label: 'Location', value: '<img src="https://untrusted">' })
    const page = recoveryPage(options)
    expect(page).toContain('&lt;script&gt;unsafe()&lt;/script&gt;')
    expect(page).not.toContain('<script>')
    expect(page).not.toContain('<img ')
    expect(page).toContain('default-src \'none\'')
    expect(page).not.toContain('data-action="show_directory"')
    expect(page).toContain('data-action="quit"')
    for (const action of ['retry', 'open_logs', 'show_directory', 'export_diagnostics', 'copy_details', 'quit'])
      expect(readRecoveryAction(`https://lexora-recovery.invalid/${action}`)).toBe(action)
    for (const url of ['file:///tmp', 'https://other/retry', 'https://lexora-recovery.invalid/retry?path=/tmp', 'https://lexora-recovery.invalid/retry#x', 'https://lexora-recovery.invalid/%72etry'])
      expect(readRecoveryAction(url)).toBeUndefined()
  })
})

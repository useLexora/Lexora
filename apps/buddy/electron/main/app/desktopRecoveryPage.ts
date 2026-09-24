import type { MessageBoxOptions } from 'electron'

export type RecoveryAction = 'retry' | 'open_logs' | 'export_diagnostics' | 'copy_details' | 'show_directory' | 'quit'

export interface RecoveryPresentation extends MessageBoxOptions {
  recovery: {
    reason: string
    notice: string
    privacy: string
    fields: Array<{ label: string, value: string, localOnly?: boolean }>
    actions: Array<{ action: RecoveryAction, label: string }>
    copyDetails: string
    moreActionsLabel: string
  }
}

const actionOrigin = 'https://lexora-recovery.invalid/'
const actions: RecoveryAction[] = ['retry', 'open_logs', 'export_diagnostics', 'copy_details', 'show_directory', 'quit']

export function readRecoveryAction(url: string): RecoveryAction | undefined {
  return actions.find(action => url === `${actionOrigin}${action}`)
}

export function recoveryPage(options: RecoveryPresentation, status = ''): string {
  const { recovery } = options
  const renderActions = (names: RecoveryAction[]) => names.flatMap(action => recovery.actions.filter(item => item.action === action)).map(({ action, label }) => `<a role="button" data-action="${action}" href="${actionOrigin}${action}"${action === 'export_diagnostics' ? ' class="primary" autofocus' : ''}>${escapeHtml(label)}</a>`).join('')
  const moreActions = renderActions(['open_logs', 'show_directory', 'copy_details'])
  const dropdown = moreActions ? `<button type="button" class="more-actions-trigger" popovertarget="more-actions">${escapeHtml(recovery.moreActionsLabel)}<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><div id="more-actions" popover>${moreActions}</div>` : ''
  const buttons = `${renderActions(['export_diagnostics', 'retry'])}${dropdown}${renderActions(['quit'])}`
  const fields = recovery.fields.map(field => `<div><dt>${escapeHtml(field.label)}</dt><dd>${escapeHtml(field.value)}</dd></div>`).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(options.title ?? 'Lexora Buddy')}</title><style>
    :root { color-scheme: light dark; font: 14px/1.65 system-ui, sans-serif; color: #242424; background: #fafafa; }
    * { box-sizing: border-box; } body { margin: 0; padding: 30px; } main { max-width: 680px; margin: auto; }
    .brand { font-size: 12px; color: #747474; letter-spacing: .08em; } h1 { font-size: 23px; font-weight: 600; line-height: 1.4; margin: 12px 0 20px; }
    .detail { overflow-wrap: anywhere; margin: 0; } .notice, .privacy { color: #686868; font-size: 12px; } .notice { margin: 12px 0 22px; }
    dl { padding: 16px; margin: 0; border: 1px solid #ddd; border-radius: 8px; background: #fff; } dl > div { display: grid; grid-template-columns: 108px minmax(0, 1fr); gap: 12px; } dl > div + div { margin-top: 14px; } dt { color: #686868; font-size: 12px; } dd { margin: 0; font: 12px/1.6 ui-monospace, monospace; overflow-wrap: anywhere; user-select: text; }
    #status { color: #99571c; margin: 16px 0; } #status:empty { display: none; }
    nav { margin-top: 24px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; } a, button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 38px; font: inherit; font-size: 13px; text-decoration: none; color: inherit; background: #fff; border: 1px solid #ccc; border-radius: 6px; padding: 7px 12px; cursor: pointer; }
    a.primary { background: #242424; color: #fff; border-color: #242424; } a[data-action="quit"] { margin-inline-start: auto; background: transparent; color: #4d4d4d; } a:hover, button:hover { background: #f0f0f0; border-color: #aaa; } a:active, button:active { background: #e8e8e8; } a.primary:hover { background: #404040; border-color: #404040; } a:focus-visible, button:focus-visible { outline: 2px solid #4278d5; outline-offset: 3px; }
    #more-actions { inset: auto; position-area: bottom span-right; position-try-fallbacks: flip-block, flip-inline, flip-block flip-inline; margin: 6px 0; min-width: 172px; max-width: calc(100vw - 32px); padding: 4px; color: inherit; background: #fff; border: 1px solid #ccc; border-radius: 6px; box-shadow: 0 2px 8px #0002; } #more-actions a { display: flex; justify-content: flex-start; min-height: 34px; border: 0; border-radius: 3px; padding: 6px 10px; } #more-actions a:hover, #more-actions a:focus-visible { background: #4278d5; color: #fff; outline: none; } nav:has(:popover-open) .more-actions-trigger { background: #f0f0f0; border-color: #aaa; }
    [aria-busy="true"] nav { opacity: .5; pointer-events: none; }
    @media (max-width: 480px) { body { padding: 24px; } dl > div { grid-template-columns: 1fr; gap: 4px; } }
    @media (prefers-color-scheme: dark) { :root { color: #eee; background: #222; } .brand, .notice, .privacy, dt { color: #aaa; } a, button, dl, #more-actions { background: #292929; border-color: #555; } a.primary { background: #eee; color: #222; border-color: #eee; } a[data-action="quit"] { color: #d2d2d2; } a:hover, button:hover, nav:has(:popover-open) .more-actions-trigger { background: #363636; border-color: #777; } a:active, button:active { background: #404040; } a.primary:hover { background: #d5d5d5; border-color: #d5d5d5; } #status { color: #edb878; } }
  </style></head><body><main><div class="brand">LEXORA BUDDY</div><h1>${escapeHtml(options.message)}</h1><p class="detail">${escapeHtml(recovery.reason)}</p><p class="notice">${escapeHtml(recovery.notice)}</p><dl>${fields}</dl><p id="status" role="status" aria-live="polite">${escapeHtml(status)}</p><nav>${buttons}</nav><p class="privacy">${escapeHtml(recovery.privacy)}</p></main></body></html>`
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\'', '&#39;')
}

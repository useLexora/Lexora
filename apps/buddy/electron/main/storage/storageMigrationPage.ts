import type { StorageOperation, StorageProgress } from '../../../shared/storage/storageApi'

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[character]!)
const preparing: StorageProgress = { phase: 'preparing', completedBytes: 0, totalBytes: null, files: 0, error: null }

function failureMessage(code: string | null): string {
  switch (code) {
    case 'STORAGE_WORKER_INTERRUPTED': return '上次整理被中断，原数据仍在。点击重试可继续完成整理。'
    case 'SNAPSHOT_DEPENDENCY_CONFLICT': return '备份中的关联记录与当前数据冲突，原数据未被替换。请取消恢复后选择其他备份。'
    case 'STORAGE_NO_SPACE': return '目标磁盘空间不足。原数据仍在，请腾出空间后重试。'
    case 'STORAGE_REFERENCE_OUTSIDE':
    case 'STORAGE_REFERENCE_MISSING': return '部分附件或会话文件缺失。请检查原目录，或使用完整备份。'
    case 'STORAGE_ROOT_IN_USE': return '目标目录正被另一实例使用。请关闭该实例后重试。'
    case 'STORAGE_CANCELLED': return '整理已停止，原数据仍在。下次启动时可重试。'
    default: return '复制或验证未完成，原数据仍在。请检查目录权限和可用空间后重试。'
  }
}

function size(bytes: number): string {
  if (bytes >= 1024 ** 3)
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2)
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.ceil(bytes / 1024)} KB`
}

function presentation(kind: StorageOperation['kind'], progress: StorageProgress, committing: boolean) {
  const failure = progress.phase === 'failed' || progress.phase === 'cancelled'
  const copying = progress.phase === 'copying'
  const percent = copying && progress.totalBytes !== null ? Math.min(100, Math.floor(progress.completedBytes / Math.max(1, progress.totalBytes) * 100)) : null
  const category = progress.category === 'browser' ? '浏览器资料' : progress.category === 'preferences' ? '窗口与桌宠偏好' : '本机资料'
  const phases: Record<StorageProgress['phase'], string> = {
    preparing: '正在检查需要保留的资料',
    copying: `正在复制${category}`,
    converting: '正在更新资料中的目录位置',
    verifying: '正在验证数据库与附件',
    activating: '即将完成，正在启用数据目录',
    completed: '资料已准备好，正在重新启动',
    failed: '整理暂未完成',
    cancelled: '整理已停止',
  }
  return {
    phase: progress.phase,
    step: failure ? -1 : progress.phase === 'preparing' ? 0 : copying ? 1 : 2,
    percent,
    text: {
      phase: phases[progress.phase],
      amount: percent === null ? '' : `${size(progress.completedBytes)} / ${size(progress.totalBytes!)}`,
      detail: failure ? failureMessage(progress.error) : copying ? `${percent === null ? '' : `复制进度 ${percent}% · `}已复制 ${progress.files.toLocaleString('zh-CN')} 个文件` : progress.phase === 'preparing' ? '正在确认文件与可用空间，文件较多时请稍候。' : '完成后会自动重新启动 Lexora，请稍候。',
      cancel: kind === 'consolidate' ? '停止整理并退出' : failure ? '使用原目录' : '取消并使用原目录',
    },
    hidden: { retry: !failure, cancel: committing || (failure && kind === 'consolidate'), exit: !failure },
  }
}

export function storageMigrationProgressScript(kind: StorageOperation['kind'], progress: StorageProgress, committing = false): string {
  const state = presentation(kind, progress, committing)
  return `(() => {
    const state = ${JSON.stringify(state)};
    for (const [id, value] of Object.entries(state.text)) document.getElementById(id).textContent = value;
    for (const [id, value] of Object.entries(state.hidden)) document.getElementById(id).hidden = value;
    document.body.dataset.phase = state.phase;
    document.getElementById('bar').style.width = state.percent === null ? '35%' : state.percent + '%';
    const track = document.getElementById('track');
    if (state.percent === null) track.removeAttribute('aria-valuenow');
    else track.setAttribute('aria-valuenow', state.percent);
    track.setAttribute('aria-valuetext', state.text.phase);
    document.querySelectorAll('[data-step]').forEach((step, index) => step.dataset.state = index < state.step ? 'done' : index === state.step ? 'active' : 'waiting');
  })()`
}

export function storageMigrationPage(operation: Pick<StorageOperation, 'kind' | 'target'>, progress: StorageProgress = preparing, committing = false): string {
  const state = presentation(operation.kind, progress, committing)
  const title = operation.kind === 'consolidate' ? '为你的资料安个新家' : operation.kind === 'restore' ? '正在恢复数据' : '正在搬迁数据'
  const explanation = operation.kind === 'consolidate'
    ? '本次升级会把分散的本机资料整理到统一目录，方便今后管理和备份。首次整理完成后，日常启动无需重复。'
    : operation.kind === 'restore' ? '正在把所选备份内容恢复到当前数据目录，未选择的内容保持原样。完成后会重新启动。' : '正在将资料复制到你选择的目录。验证完成后，Lexora 会从新目录启动。'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Lexora · 数据整理</title><style>
    :root{color-scheme:light dark;--bg:light-dark(#fafafc,#191a20);--fg:light-dark(#292b35,#ededf2);--muted:light-dark(#676a78,#a9adbc);--line:light-dark(#e2e3eb,#363844);--accent:light-dark(#7763ba,#b3a1ef);--soft:light-dark(#eeebf7,#2e293e);--safe:light-dark(#47735f,#96c3aa);font:14px/1.65 system-ui,sans-serif;color:var(--fg);background:var(--bg)}
    *{box-sizing:border-box}body{margin:0;padding:30px 36px 28px}header{display:flex;align-items:center;gap:12px;color:var(--muted);font-size:12px;letter-spacing:.03em}.symbol{width:40px;height:40px;display:grid;place-items:center;background:var(--soft);border-radius:12px;color:var(--accent)}.symbol svg{width:24px;height:24px;animation:breathe 2s ease-in-out infinite}h1{font-size:25px;line-height:1.35;letter-spacing:-.03em;margin:22px 0 12px;font-weight:650}.intro{color:var(--muted);margin:0;max-width:40em}.safety{display:flex;align-items:center;gap:8px;color:var(--safe);margin:14px 0 22px;font-size:13px}.safety svg{width:16px;height:16px;flex:none}.location{border-block:1px solid var(--line);padding:12px 0;display:flex;gap:18px;align-items:baseline;font-size:12px}.location span{color:var(--muted);white-space:nowrap}.location code{font:12px/1.6 ui-monospace,monospace;overflow-wrap:anywhere;min-width:0}ol{display:flex;list-style:none;margin:25px 0 22px;padding:0;gap:12px}li{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--muted);flex:1;white-space:nowrap}li:not(:last-child):after{content:'';height:1px;background:var(--line);flex:1;margin-left:5px}li b{font-size:10px;font-weight:500;display:grid;place-items:center;width:19px;height:19px;border:1px solid var(--line);border-radius:50%}li[data-state=active]{color:var(--accent);font-weight:600}li[data-state=active] b{border-color:var(--accent);background:var(--soft)}li[data-state=done] b{color:var(--accent);background:var(--soft);border-color:transparent}.status-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px}#phase{font-size:14px;font-weight:600;margin:0}#amount{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}.track{height:5px;background:var(--line);border-radius:5px;overflow:hidden;margin:12px 0 9px}#bar{height:100%;background:var(--accent);border-radius:inherit;transition:width .2s}#detail{font-size:12px;color:var(--muted);margin:0;min-height:20px;font-variant-numeric:tabular-nums}.note{color:var(--muted);font-size:12px;margin:23px 0 18px}nav{display:flex;justify-content:flex-end;gap:10px}a{display:inline-flex;align-items:center;min-height:34px;padding:5px 13px;border:1px solid var(--line);border-radius:7px;color:var(--fg);text-decoration:none;font-size:12px}a:hover{background:var(--soft)}a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}#retry{background:var(--accent);border-color:var(--accent);color:var(--bg)}[hidden]{display:none!important}body[data-phase=failed] #phase,body[data-phase=cancelled] #phase{color:light-dark(#966436,#d6b081)}body[data-phase=failed] .track,body[data-phase=cancelled] .track{visibility:hidden}body[data-phase=failed] .symbol svg,body[data-phase=cancelled] .symbol svg,body[data-phase=completed] .symbol svg{animation:none}body:not([data-phase=copying]):not([data-phase=failed]):not([data-phase=cancelled]) #bar{animation:travel 1.8s ease-in-out infinite}@keyframes breathe{50%{transform:translateY(-2px);opacity:.55}}@keyframes travel{50%{transform:translateX(180%)}}@media(prefers-reduced-motion:reduce){*,#bar,.symbol svg{animation:none!important;transition:none!important}}@media(max-width:480px){body{padding:24px}h1{font-size:23px}.status-row{align-items:flex-start;flex-direction:column;gap:2px}ol{gap:7px}li{gap:5px}.location{gap:12px}}
    </style></head><body data-phase="${state.phase}"><header><div class="symbol" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M8 14h8m-3-3 3 3-3 3"/></svg></div><span>Lexora · ${operation.kind === 'consolidate' ? '首次升级整理' : operation.kind === 'restore' ? '恢复备份' : '更改数据目录'}</span></header>
    <h1>${title}</h1><p class="intro">${explanation}</p><p class="safety"><svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m10 2 6 3v5c0 4-6 7-6 7s-6-3-6-7V5Z"/><path d="m7 9 2 2 4-4"/></svg>原数据会保留 · 本次操作仅在本机进行</p>
    <div class="location"><span>整理到</span><code>${escape(operation.target)}</code></div>
    <ol aria-label="整理步骤">${['检查资料', '复制资料', '完成准备'].map((label, index) => `<li data-step="${index}" data-state="${index < state.step ? 'done' : index === state.step ? 'active' : 'waiting'}"><b aria-hidden="true">${index + 1}</b>${label}</li>`).join('')}</ol>
    <div class="status-row"><p id="phase" role="status" aria-live="polite">${state.text.phase}</p><span id="amount">${state.text.amount}</span></div><div id="track" class="track" role="progressbar" aria-label="资料复制进度" aria-valuemin="0" aria-valuemax="100" ${state.percent === null ? '' : `aria-valuenow="${state.percent}"`} aria-valuetext="${state.text.phase}"><div id="bar" style="width:${state.percent ?? 35}%"></div></div><p id="detail">${escape(state.text.detail)}</p>
    <p class="note">${operation.kind === 'restore' ? '恢复前的数据将保留为副本，浏览器资料与缓存不受影响。' : '缓存、旧日志与崩溃报告留在原位置，无需搬迁。'}<br>完成后会自动重新启动 Lexora。</p><nav aria-label="整理操作">${(['cancel', 'retry', 'exit'] as const).map(id => `<a id="${id}" href="https://storage.lexora.invalid/${id}" ${state.hidden[id] ? 'hidden' : ''}>${id === 'cancel' ? state.text.cancel : id === 'retry' ? '重试' : '退出'}</a>`).join('')}</nav></body></html>`
}

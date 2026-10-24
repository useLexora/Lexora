import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(new URL('../../../apps/buddy/package.json', import.meta.url))
const { zipSync } = require('fflate/node')

export const clipboardProbeId = 'tests.clipboard-boundaries'

function activate(context) {
  context.subscriptions.add(context.commands.register('tests.clipboard-boundaries.open', () => context.views.open('tests.clipboard-boundaries.editor')))
}

function render(context, container) {
  container.innerHTML = '<main data-clipboard-probe style="padding:24px"><button id="write">写入剪贴板</button><button id="read">读取剪贴板</button><button id="title">更新文件信息</button><output role="status"></output></main>'
  const output = container.querySelector('output')
  const payload = { text: '季度计划\t42', html: '<table data-copy-id="fixture-copy"><tr><td><b>季度计划</b></td><td>42</td></tr></table>' }
  const capture = async (action) => {
    try {
      return { ok: true, value: await action() ?? null }
    }
    catch (error) {
      return { ok: false, error: error.message }
    }
  }
  globalThis.clipboardProbe = {
    read: () => capture(() => context.clipboard.read()),
    write: () => capture(() => context.clipboard.write(payload)),
    installCloseGuard: (delay = 0) => context.onBeforeClose(async (signal) => {
      if (delay) {
        await new Promise((resolve, reject) => {
          let timer
          const cancel = () => {
            clearTimeout(timer)
            reject(new Error('CANCELLED'))
          }
          timer = setTimeout(() => {
            signal.removeEventListener('abort', cancel)
            resolve()
          }, delay)
          signal.addEventListener('abort', cancel, { once: true })
        })
      }
      await context.setState({ saved: true })
      await context.setDocumentInfo({ title: '季度计划.xlsx', dirty: false })
      return true
    }),
  }
  for (const [id, action] of Object.entries({
    write: globalThis.clipboardProbe.write,
    read: globalThis.clipboardProbe.read,
    title: () => capture(() => context.setDocumentInfo({ title: '季度计划.xlsx', dirty: true })),
  })) {
    container.querySelector(`#${id}`).addEventListener('click', async () => {
      output.textContent = '正在执行…'
      output.textContent = JSON.stringify({ operation: id, ...await action() })
    })
  }
  container.querySelector('[data-clipboard-probe]').dataset.ready = 'true'
}

export async function writeClipboardProbe(directory, granted = true) {
  await fs.mkdir(directory, { recursive: true })
  const id = clipboardProbeId
  const manifest = {
    schemaVersion: 1,
    format: 'compiled',
    id,
    name: '剪贴板验收',
    version: '1.0.0',
    apiVersion: 4,
    engines: { lexora: '>=0.15.0' },
    entry: 'extension.js',
    permissions: { clipboardRead: granted, clipboardWrite: granted },
    contributes: {
      commands: [{ id: `${id}.open`, title: '打开剪贴板验收', slash: { name: 'open' } }],
      views: [
        { id: `${id}.page`, title: '剪贴板验收', entry: 'view.js', resource: 'none', location: 'page' },
        { id: `${id}.editor`, title: '剪贴板验收', entry: 'view.js', resource: 'none', location: 'context' },
      ],
      navigation: { title: '剪贴板验收', view: `${id}.page`, showHeader: false },
    },
  }
  const files = {
    'extension.json': JSON.stringify(manifest),
    'extension.js': `export ${activate.toString()}`,
    'view.js': `export ${render.toString()}`,
  }
  const archive = path.join(directory, 'clipboard.lexora-extension')
  await fs.writeFile(archive, zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, Buffer.from(text)])), { level: 6 }))
  return { id, archive }
}

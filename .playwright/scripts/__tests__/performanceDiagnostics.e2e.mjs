import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { expect, test } from '../fixtures/electron.mjs'

const { unzipSync, strFromU8 } = createRequire(new URL('../../../apps/buddy/package.json', import.meta.url))('fflate/node')

test('performance capture stays local, identifies processes and exports bounded metadata', async ({ buddy }, testInfo) => {
  const instance = await buddy.createInstance('performance-diagnostics')
  const { page, app, diagnostics } = await instance.launch()
  await page.evaluate(() => window.location.hash = '/settings/logs')
  const header = page.locator('.desktop-settings-page__header')
  const panel = page.getByTestId('performance-diagnostics')
  await expect(header.getByRole('button', { name: '性能诊断' })).toBeVisible()
  await expect(header.getByRole('button', { name: '导出诊断包' })).toBeVisible()
  await expect(panel).toHaveCount(0)
  const live = header.getByRole('switch')
  await expect(live).toBeChecked()
  await live.click()
  await expect(live).not.toBeChecked()
  await expect(page.locator('.application-logs__status')).toContainText('已暂停更新')
  await live.click()
  await expect(live).toBeChecked()
  await testInfo.attach('logs-header', { body: await page.screenshot(), contentType: 'image/png' })

  const extra = await app.evaluate(async ({ BrowserWindow }) => {
    const window = new BrowserWindow({ show: false })
    await window.loadURL('data:text/html,<p>Diagnostic fixture</p>')
    return { id: window.id, pid: window.webContents.getOSProcessId() }
  })
  await header.getByRole('button', { name: '性能诊断' }).click()
  await expect(panel).toBeVisible()
  await expect(panel.getByText('界面 · 当前窗口', { exact: true })).toBeVisible()
  const collectionDetails = page.getByText('仅记录性能摘要，不含对话、文件内容或原始堆栈。指标不含 FFmpeg 等外部子进程和桌宠。', { exact: true })
  await panel.getByRole('button', { name: '采集说明', exact: true }).click()
  await expect(collectionDetails).toBeVisible()
  await panel.getByRole('button', { name: '采集说明', exact: true }).click()
  await expect(collectionDetails).not.toBeVisible()
  const otherRenderer = panel.getByRole('row').filter({ hasText: String(extra.pid) })
  await expect(otherRenderer).toContainText('仅显示指标', { timeout: 12000 })
  await expect(otherRenderer.getByRole('button')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '分析 5 秒', exact: true })).toHaveCount(3)
  const wrongTargetRejected = await page.evaluate(async () => {
    try {
      await window.lexoraDesktop.app.performance.capture({ target: 'runtime', pid: 0 })
      return false
    }
    catch { return true }
  })
  expect(wrongTargetRejected).toBe(true)

  const processNames = panel.locator('tbody tr td:first-child')
  await expect.poll(() => processNames.allTextContents()).toEqual(['主进程', '任务运行时', '界面 · 当前窗口', '界面', '图形', '网络'])
  const processPids = await panel.locator('tbody tr td:nth-child(2)').allTextContents()
  const runtime = panel.getByRole('row').filter({ hasText: '任务运行时' })
  const runtimePid = (await runtime.locator('td').nth(1).textContent()).trim()
  await runtime.getByRole('button', { name: '分析 5 秒' }).click()
  await expect(panel.getByRole('status')).toContainText(`正在分析任务运行时（PID ${runtimePid}）`)
  await expect(panel.getByRole('button', { name: '关闭', exact: true })).toBeDisabled()
  await expect(panel.getByRole('status')).toContainText(`已完成任务运行时（PID ${runtimePid}）的分析`, { timeout: 15000 })
  expect(await panel.locator('tbody tr td:nth-child(2)').allTextContents()).toEqual(processPids)
  await testInfo.attach('performance-dialog', { body: await page.screenshot(), contentType: 'image/png' })

  const results = []
  for (const target of ['main', 'renderer']) {
    const result = await page.evaluate(async (target) => {
      const api = window.lexoraDesktop.app.performance
      const snapshot = await api.snapshot()
      const pid = target === 'renderer' ? snapshot.rendererPid : snapshot.samples.at(-1).processes.find(item => item.role === 'main').pid
      return api.capture({ target, pid })
    }, target)
    expect(result).toMatchObject({ target, pid: expect.any(Number) })
    expect(result.durationMs).toBeGreaterThan(4500)
    expect(result.samples).toBeGreaterThan(0)
    expect(result.hotspots.length).toBeLessThanOrEqual(20)
    expect(JSON.stringify(result)).not.toMatch(/file:\/\/|\/home\/|functionName|scriptId|callFrame/)
    results.push(result)
  }
  const snapshot = await page.evaluate(() => window.lexoraDesktop.app.performance.snapshot())
  expect(snapshot.coverage).toBe('electron-processes')
  expect(snapshot.samples.length).toBeLessThanOrEqual(60)
  expect(snapshot.samples.at(-1).logicalCpuCount).toBeGreaterThan(0)
  const filename = path.join(instance.home, 'diagnostics.zip')
  await app.evaluate(({ dialog }, filename) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename })
  }, filename)
  await panel.getByRole('button', { name: '导出诊断包' }).click()
  await expect(panel).toHaveCount(0)
  await page.getByRole('button', { name: '导出 ZIP', exact: true }).click()
  await expect.poll(async () => fs.stat(filename).then(stat => stat.size).catch(() => 0)).toBeGreaterThan(0)
  const archive = unzipSync(await fs.readFile(filename))
  const context = strFromU8(archive['context.jsonl']).trim().split('\n').map(line => JSON.parse(line))
  expect(context.filter(record => record.cpuProfile).map(record => record.cpuProfile.target).sort()).toEqual(['main', 'renderer', 'runtime'])
  expect(context.find(record => record.cpuProfile?.target === 'runtime').cpuProfile.pid).toBe(Number(runtimePid))
  expect(strFromU8(archive['context.jsonl'])).not.toMatch(/functionName|scriptId|callFrame|file:\/\/|\/home\//)
  const summaryPath = testInfo.outputPath('performance-summary.json')
  await fs.writeFile(summaryPath, JSON.stringify({ profiles: results, snapshot }, null, 2))
  await testInfo.attach('performance-summary', { path: summaryPath, contentType: 'application/json' })

  await header.getByRole('button', { name: '性能诊断' }).click()
  await expect(panel).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.close(), extra.id)
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

test('renderer CPU summaries retain locations from bundled Vue code', async ({ buddy }, testInfo) => {
  const instance = await buddy.createInstance('renderer-cpu-locations')
  const { page } = await instance.launch()
  const { filename, profile } = await page.evaluate(async () => {
    const url = document.querySelector('link[rel="modulepreload"][href*="/vue.runtime.esm-bundler-"]')?.href
    if (!url)
      throw new Error('Bundled Vue runtime was not loaded')
    const exports = await import(url)
    const vue = Object.values(exports).find(value => value && typeof value === 'object' && typeof value.reactive === 'function' && typeof value.computed === 'function')
    if (!vue)
      throw new Error('Bundled Vue runtime exports were not found')
    const state = vue.reactive({ count: 0 })
    const doubled = vue.computed(() => state.count * 2)
    let observed = 0
    const timer = setInterval(() => {
      const until = performance.now() + 20
      while (performance.now() < until) {
        state.count++
        observed = doubled.value
      }
    }, 25)
    try {
      const api = window.lexoraDesktop.app.performance
      const { rendererPid } = await api.snapshot()
      const profile = await api.capture({ target: 'renderer', pid: rendererPid })
      if (!observed)
        throw new Error('Reactive workload did not run')
      return { filename: new URL(url).pathname.split('/').at(-1), profile }
    }
    finally {
      clearInterval(timer)
    }
  })
  const code = createHash('sha256').update(filename).digest('hex').slice(0, 12)
  expect(profile.hotspots.some(hotspot => hotspot.location.startsWith(`renderer:${code}:`) && hotspot.selfMs > 0)).toBe(true)
  expect(JSON.stringify(profile)).not.toMatch(/vue\.runtime|functionName|scriptId|callFrame|lexora-app:|file:/)
  await testInfo.attach('renderer-cpu-locations', { body: JSON.stringify({ filename, profile }, null, 2), contentType: 'application/json' })
})

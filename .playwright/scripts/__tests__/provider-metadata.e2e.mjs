import http from 'node:http'
import { expect, test, useSyntheticCredentialStorage } from '../fixtures/electron.mjs'

const modelId = 'opaque-alias-high'

test('custom service wizard discovers and displays service model metadata', async ({ buddy }, testInfo) => {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ models: [{
      slug: modelId,
      display_name: 'Fixture model',
      context_window: 1048576,
      max_tokens: 65536,
      input_modalities: ['text', 'image'],
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'ultra' }],
    }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const instance = await buddy.createInstance('provider-metadata')
    const desktop = await instance.launch()
    await useSyntheticCredentialStorage(desktop)
    const { page } = desktop
    await page.locator('.desktop-app-sidebar').getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('.desktop-settings-sidebar').getByRole('link', { name: '模型服务', exact: true }).click()
    await page.locator('.desktop-models-settings__heading').getByRole('button', { name: '添加服务', exact: true }).click()
    const wizard = page.locator('.desktop-provider-add-dialog')
    await wizard.locator('.n-tabs-tab').filter({ hasText: '自定义 API' }).click()
    const form = wizard.locator('.desktop-custom-provider-form')
    await form.getByPlaceholder('输入显示名称').fill('Fixture service')
    await form.getByPlaceholder('https://api.example.com/v1').fill(`http://127.0.0.1:${server.address().port}/v1`)
    await form.getByRole('button', { name: '继续', exact: true }).click()
    await wizard.getByRole('button', { name: '配置 API Key', exact: true }).click()
    const auth = page.locator('.desktop-provider-auth')
    await auth.locator('input[type="password"]').fill('fixture-key')
    await auth.getByRole('button', { name: '继续', exact: true }).click()
    await wizard.getByRole('button', { name: '同步模型', exact: true }).click()
    const discovered = wizard.locator('.desktop-provider-add-dialog__model-row').filter({ hasText: modelId })
    await expect(discovered.locator('small')).toHaveText(modelId)
    await expect(discovered.getByText('Fixture model', { exact: true })).toBeVisible()
    const enabled = discovered.getByRole('switch')
    await expect(enabled).not.toBeChecked()
    await enabled.click()
    await expect(enabled).toBeChecked()
    await wizard.getByRole('button', { name: '完成并启用', exact: true }).click()
    await expect(wizard).toHaveCount(0)
    const provider = page.locator('.desktop-models-settings__provider-row').filter({ hasText: 'Fixture service' })
    await expect(provider.getByRole('switch')).toBeChecked()
    await provider.getByRole('button', { name: '管理', exact: true }).click()
    const model = page.locator('.desktop-provider-detail__model-row').filter({ hasText: modelId })
    await expect(model.getByRole('switch')).toBeChecked()
    await expect(model.getByRole('checkbox', { name: '图片', exact: true })).toBeChecked()
    await model.getByRole('button', { name: '管理', exact: true }).click()
    const detail = page.locator('.desktop-model-detail-dialog')
    await expect(detail.getByText('模型能力', { exact: true })).toBeVisible()
    await expect(detail.locator('.desktop-model-capabilities-panel').getByRole('checkbox', { name: '图片', exact: true })).toBeChecked()
    await expect(detail.locator('.desktop-model-thinking-panel')).toContainText('low / medium / high')
    await expect(detail.locator('.desktop-model-parameters-panel dd')).toHaveText(['1,048,576', '65,536'])
    await page.screenshot({ path: testInfo.outputPath('service-model-metadata.png'), animations: 'disabled' })
    expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  }
  finally {
    await new Promise(resolve => server.close(resolve))
  }
})

import { expect } from './electron.mjs'

export async function selectComposerModel(page, model, reasoning) {
  await page.locator('.desktop-model-selector__trigger:visible').click()
  await page.locator('.desktop-model-selector__advanced').click()
  const advanced = page.locator('.desktop-model-selector__panel--advanced')
  await advanced.getByRole('button', { name: /^模型/ }).click()
  const picker = page.locator('.desktop-model-picker')
  await picker.getByPlaceholder('搜索模型…').fill(model.modelId)
  await picker.getByRole('menuitemradio', { name: `${model.displayName} ${model.modelId}`, exact: true }).click()
  if (reasoning !== null) {
    const index = model.reasoningOptions.indexOf(reasoning)
    if (index < 0)
      throw new Error(`Unsupported fixture reasoning: ${model.modelId}/${reasoning}`)
    await advanced.locator('.desktop-model-selector__back').click()
    const slider = page.getByRole('slider')
    await expect(slider).toHaveAttribute('aria-disabled', 'false')
    const bounds = await slider.boundingBox()
    await slider.click({ position: { x: 8 + (bounds.width - 16) * index / Math.max(1, model.reasoningOptions.length - 1), y: bounds.height / 2 } })
    await expect(slider).toHaveValue(String(index))
  }
  await page.keyboard.press('Escape')
}

export async function selectComposerPermission(page, name) {
  await page.locator('.desktop-permission-mode-selector__trigger:visible').click()
  await page.getByRole('menuitemradio', { name: new RegExp(name) }).click()
  if (name === '完全访问') {
    await page.getByRole('checkbox', { name: '我已了解风险，并愿意继续' }).check()
    await page.getByRole('button', { name: '允许完全访问', exact: true }).click()
  }
}

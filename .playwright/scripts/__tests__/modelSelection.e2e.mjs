import { expect, test, useSyntheticCredentialStorage } from '../fixtures/electron.mjs'

test('model controls preview dragging, commit on release and retain advanced panel selections', async ({ buddy }) => {
  const instance = await buddy.createInstance('model-selection')
  const desktop = await instance.launch()
  const { page } = desktop
  await useSyntheticCredentialStorage(desktop)
  const model = await page.evaluate(async () => {
    const providers = window.lexoraDesktop.localChat.providers
    const provider = await providers.add('openai')
    const stop = providers.onAuthChallenge((challenge) => {
      if (challenge.providerId === provider.id && challenge.type === 'secret')
        void providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
    })
    try {
      await providers.login(provider.id, 'api_key')
    }
    finally {
      stop()
    }
    const model = (await providers.listModels(provider.id)).find(model => model.reasoningOptions.length > 2 && model.serviceTiers.some(tier => tier.id === 'priority'))
    if (!model)
      throw new Error('The offline catalog must include a reasoning model with fast mode')
    await providers.setModelEnabled(provider.id, model.modelId, true)
    await providers.setEnabled(provider.id, true)
    await providers.setDefaultModel({ providerId: provider.id, modelId: model.modelId, reasoning: model.reasoningOptions[0] })
    return model
  })
  await page.reload()
  const trigger = page.locator('.desktop-model-selector__trigger:visible')
  await expect(trigger).toBeEnabled()
  const initialLabel = await trigger.getAttribute('aria-label')
  await trigger.click()
  const slider = page.getByRole('slider')
  await expect(slider).toBeVisible()
  const targetIndex = Number(await slider.inputValue()) === model.reasoningOptions.length - 1 ? 0 : model.reasoningOptions.length - 1
  const bounds = await slider.boundingBox()
  await page.mouse.move(bounds.x + 4, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds.x + (targetIndex === 0 ? 4 : bounds.width - 4), bounds.y + bounds.height / 2, { steps: 6 })
  await expect(slider).toHaveValue(String(targetIndex))
  const finalLevel = await slider.getAttribute('aria-valuetext')
  await expect(trigger).toHaveAttribute('aria-label', initialLabel)
  await expect(page.locator('.desktop-model-selector__dragging-effort')).toHaveText(finalLevel)
  await page.mouse.up()
  await expect(trigger).toHaveAttribute('aria-label', `${model.displayName} · ${finalLevel}`)
  await expect(slider).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(slider).toBeHidden()
  await trigger.click()
  await expect(slider).toHaveValue(String(targetIndex))

  const fastMode = page.getByRole('switch', { name: 'Fast', exact: true })
  await fastMode.click()
  await expect(fastMode).toBeChecked()
  await page.locator('.desktop-model-selector__advanced').click()
  const advanced = page.locator('.desktop-model-selector__panel--advanced')
  const speed = advanced.getByRole('menuitemcheckbox')
  await expect(speed).toBeChecked()
  await speed.click()
  await expect(speed).not.toBeChecked()
  await advanced.getByRole('button', { name: /^模型/ }).click()
  const models = page.locator('.desktop-model-picker')
  await expect(models).toBeVisible()
  await models.getByPlaceholder('搜索模型…').fill(model.displayName)
  await models.getByRole('menuitemradio', { name: `${model.displayName} ${model.modelId}`, exact: true }).click()
  await expect(trigger).toContainText(model.displayName)
  await advanced.locator('.desktop-model-selector__back').click()
  await expect(slider).toBeVisible()
  await expect(fastMode).not.toBeChecked()
  const advancedValue = await slider.inputValue()
  await page.keyboard.press('Escape')
  await expect(slider).toBeHidden()
  await trigger.click()
  await expect(slider).toHaveValue(advancedValue)
  await page.keyboard.press('Escape')
  expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

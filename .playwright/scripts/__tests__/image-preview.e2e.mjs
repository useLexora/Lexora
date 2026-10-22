import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import path from 'node:path'
import { withArtifactPreview } from '../fixtures/artifact-preview.mjs'
import { expect, test } from '../fixtures/electron.mjs'

const original = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAFAAAAAwCAIAAAAJh2qgAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAVklEQVR4nO3PgQnAIADAMAVv9GTPkn2xQZdc0M579viT9XXA2wzXGa4zXGe4znCd4TrDdYbrDNcZrjNcZ7jOcJ3hOsN1husM1xmuM1xnuM5wneE6w3UP69UC2Ffb+dkAAAAASUVORK5CYII=', 'base64')
const recovered = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAHgAAABICAIAAACyfKYoAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAvElEQVR4nO3QQQ3AIADAQEjwN1eIQ9VUrDx2p6DpfPYZfG/dDvgLoyNGR4yOGB0xOmJ0xOiI0RGjI0ZHjI4YHTE6YnTE6IjREaMjRkeMjhgdMTpidMToiNERoyNGR4yOGB0xOmJ0xOiI0RGjI0ZHjI4YHTE6YnTE6IjREaMjRkeMjhgdMTpidMToiNERoyNGR4yOGB0xOmJ0xOiI0RGjI0ZHjI4YHTE6YnTE6IjREaMjRkeMjhgdMTpidOQFvTICvdnwlzoAAAAASUVORK5CYII=', 'base64')

async function inspect(app, url) {
  return app.evaluate(async ({ net }, url) => {
    const response = await net.fetch(url)
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      csp: response.headers.get('content-security-policy'),
      bytes: [...new Uint8Array(await response.arrayBuffer())],
    }
  }, url)
}

test('skill image resources decode through their scoped URL and deny reads after source removal', async ({ buddy }) => {
  const instance = await buddy.createInstance('skill-image-stream')
  const source = path.join(instance.home, 'buddy', 'agent', 'skills', 'image-guide')
  await fs.mkdir(source, { recursive: true })
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: image-guide\ndescription: Image resource preview fixture\n---\n\nImage resource preview.\n')
  await fs.writeFile(path.join(source, 'preview.png'), original)
  const { app, page, diagnostics } = await instance.launch()
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('link', { name: 'Skills', exact: true }).click()
  const row = page.locator('[data-skill-name="image-guide"]')
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: /image-guide/ }).click()
  await page.locator('.skill-detail__tabs').getByText('文件', { exact: true }).click()
  await page.locator('.skill-files [data-path="preview.png"]').click()
  const image = page.locator('.skill-files__image img')
  await expect.poll(() => image.evaluate(element => element.naturalWidth)).toBe(80)
  const url = await image.getAttribute('src')
  expect(url).toMatch(/^lexora-file:\/\/skill-preview\//)
  expect(await inspect(app, url)).toMatchObject({ status: 200, type: 'image/png', bytes: [...original] })
  await fs.rm(source, { recursive: true })
  expect(await inspect(app, url)).toMatchObject({ status: 404, bytes: [] })
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

test('images use scoped streams in both views and recover from decode failure without Base64 IPC', async ({ buddy }) => {
  await withArtifactPreview(buddy, {
    label: 'image-streams',
    async prepare(directory) {
      await fs.writeFile(path.join(directory, 'sample 图片.png'), original)
      await fs.writeFile(path.join(directory, 'broken.png'), Buffer.from([137, 80, 78, 71, 0]))
      return ['sample 图片.png', 'broken.png']
    },
  }, async ({ app, page, directory, output }) => {
    const card = output('sample 图片.png')
    await expect.poll(() => card.locator('img').evaluate(image => image.naturalWidth)).toBe(80)
    await card.hover()
    await card.locator('.buddy-artifact-collection__open').click()
    const artifactImage = page.locator('.desktop-artifact-context-surface:visible .desktop-artifact-context-surface__preview-trigger img')
    await expect.poll(() => artifactImage.evaluate(image => image.naturalWidth)).toBe(80)
    const artifactUrl = await artifactImage.getAttribute('src')
    expect(artifactUrl).toMatch(/^lexora-artifact:\/\/preview\//)
    const artifactResponse = await inspect(app, artifactUrl)
    expect(artifactResponse).toMatchObject({ status: 200, type: 'image/png', bytes: [...original] })
    expect(artifactResponse.csp).toContain('default-src \'none\'')

    await card.hover()
    await card.locator('.buddy-artifact-collection__more').click()
    await page.locator('.n-dropdown-menu:visible').getByText('在文件中定位', { exact: true }).click()
    await expect(page.locator('.n-dropdown-menu:visible')).toHaveCount(0)
    const surface = page.locator('.file-preview:visible')
    const image = surface.locator('img')
    await expect.poll(() => image.evaluate(element => element.naturalWidth)).toBe(80)
    const fileUrl = await image.getAttribute('src')
    expect(fileUrl).toMatch(/^lexora-file:\/\/media\//)
    const metadata = await page.evaluate(async (src) => {
      const query = new URL(src).searchParams
      return window.lexoraDesktop.localChat.spaces.readFile({
        spaceId: query.get('spaceId'),
        directoryId: query.get('directoryId'),
        revision: Number(query.get('revision')),
        path: query.get('path'),
      })
    }, fileUrl)
    expect(metadata).toMatchObject({ kind: 'image', text: null, sizeBytes: original.length, imageUrl: expect.stringMatching(/^lexora-file:/) })
    expect((await inspect(app, fileUrl)).bytes).toEqual([...original])

    await output('broken.png').hover()
    await output('broken.png').locator('.buddy-artifact-collection__more').click()
    await page.locator('.n-dropdown-menu:visible').getByText('在文件中定位', { exact: true }).click()
    await expect(surface.getByRole('alert')).toBeVisible()
    await fs.writeFile(path.join(directory, 'broken.png'), recovered)
    await surface.locator('.file-preview__retry').click()
    await expect.poll(() => surface.locator('img').evaluate(element => element.naturalWidth)).toBe(120)
    await expect(surface.getByRole('alert')).toHaveCount(0)

    await page.evaluate(async (src) => {
      const spaceId = new URL(src).searchParams.get('spaceId')
      await window.lexoraDesktop.localChat.spaces.update({ spaceId, name: '文件产物验收', memoryScope: 'space_only', primaryDirectory: null })
    }, fileUrl)
    expect(await inspect(app, fileUrl)).toMatchObject({ status: 404, bytes: [] })
    expect(await inspect(app, artifactUrl)).toMatchObject({ status: 404, bytes: [] })
  })
})

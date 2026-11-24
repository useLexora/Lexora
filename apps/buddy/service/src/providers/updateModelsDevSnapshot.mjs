import { mkdir, readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { ModelsDevCatalog } from './ModelsDevCatalog.ts'

async function update() {
  const response = await fetch('https://models.dev/experimental/v2.0/api.json', { signal: AbortSignal.timeout(15_000) })
  if (!response.ok)
    throw new Error(`models.dev: HTTP ${response.status}`)
  const text = await response.text()
  if (text.length > 20 * 1024 * 1024)
    throw new Error('models.dev snapshot exceeds size limit')
  const data = JSON.parse(text)
  if (!data.openai?.models || !data.anthropic?.models)
    throw new Error('Invalid models.dev snapshot')
  const directory = new URL('./data/', import.meta.url)
  await mkdir(directory, { recursive: true })
  const license = await readFile(new URL('LICENSE', directory), 'utf8')
  const updatedAt = new Date().toISOString()
  const catalog = new ModelsDevCatalog(data)
  const summary = { updatedAt, modelCount: catalog.getModels().length, providerCount: catalog.getProviders().length }
  await writeFile(new URL('models-dev.json', directory), `${JSON.stringify({ version: 1, updatedAt, license, data })}\n`)
  await writeFile(new URL('models-dev-summary.json', directory), `${JSON.stringify(summary, null, 2)}\n`)
  process.stdout.write(`Updated models.dev snapshot (${Object.keys(data).length} providers)\n`)
}

update().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

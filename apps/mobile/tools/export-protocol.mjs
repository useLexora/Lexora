import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { assertMobileSchema } from './protocol-schema.mjs'

async function main() {
  const root = fileURLToPath(new URL('../../..', import.meta.url))
  const require = createRequire(resolve(root, 'apps/buddy/package.json'))
  const { runnerImport } = await import(require.resolve('vite'))
  const { z } = require('zod')

  const { module: source } = await runnerImport(fileURLToPath(new URL('./protocol-source.ts', import.meta.url)), { configFile: false, root: resolve(root, 'apps/buddy') })
  const convert = (schema, io = 'output') => {
    const result = z.toJSONSchema(schema, {
      unrepresentable({ zodSchema, path, message }) {
        const representation = source.MOBILE_SCHEMA_OVERRIDES.get(zodSchema)
        if (representation)
          return representation
        throw new Error(`${message} at ${path.join('/')}`)
      },
      io,
      override({ zodSchema, jsonSchema }) {
        const regex = zodSchema._zod.def.checks?.map(check => check._zod.def.pattern).find(pattern => pattern instanceof RegExp)
        if (regex?.flags)
          jsonSchema['x-pattern-flags'] = regex.flags
      },
    })
    assertMobileSchema(result)
    return result
  }
  const schemas = {
    version: 1,
    uploadPolicy: source.REMOTE_UPLOAD_POLICY,
    topics: Object.fromEntries(Object.entries(source.PRODUCT_TOPIC_SCHEMAS).map(([key, value]) => [key, { item: convert(value.item), change: convert(value.change) }])),
    pairing: Object.fromEntries(Object.entries(source.pairing).filter(([key]) => key.endsWith('Schema')).map(([key, value]) => [key, convert(value, 'input')])),
    methods: Object.fromEntries(Object.entries(source.PRODUCT_METHODS).map(([key, value]) => [key, { input: convert(value.input, 'input'), output: convert(value.output), command: value.command }])),
    initialize: { input: convert(source.productInitializeSchema, 'input'), output: convert(source.productInitializeResultSchema) },
    content: convert(source.productContentSchema),
    sync: Object.fromEntries(Object.entries(source.sync).filter(([key]) => key.endsWith('Schema')).map(([key, value]) => [key, convert(value)])),
  }
  const directory = resolve(process.argv[2] ?? resolve(root, 'apps/mobile/android/build/generated/protocol'))
  await mkdir(directory, { recursive: true })
  await writeFile(resolve(directory, 'protocol-schema.json'), `${JSON.stringify(schemas)}\n`)
  await writeFile(resolve(directory, 'reader-protocol.json'), `${JSON.stringify(Object.fromEntries(Object.entries(source.READER_SCHEMAS).map(([name, value]) => [name, convert(value)])))}\n`)
  for (const name of ['vectors.json', 'content-behavior-vectors.json'])
    await copyFile(resolve(root, 'apps/buddy/shared/productProtocol', name), resolve(directory, name))
  process.stdout.write(`Exported ${Object.keys(schemas.methods).length} product methods\n`)
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

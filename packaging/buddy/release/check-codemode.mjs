import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

async function main() {
  const wasm = createRequire(import.meta.url).resolve('quickjs-wasi/quickjs.wasm')
  const entry = import.meta.resolve('@earendil-works/pi-codemode')
  const root = `${realpathSync(process.cwd())}${sep}`
  for (const path of [wasm, fileURLToPath(entry)])
    assert.ok(realpathSync(path).startsWith(root), `CodeMode dependency outside packaged service: ${path}`)

  const { CodemodeSandbox, loadQuickJSWasm } = await import(entry)
  const sandbox = new CodemodeSandbox({
    wasm: loadQuickJSWasm(wasm),
    tools: [{ name: 'double', execute: ({ value }) => value * 2 }],
  })
  try {
    const result = await sandbox.execute('return await tools.double({ value: 21 })')
    assert.ok(result.ok, JSON.stringify(result.error))
    assert.equal(result.value, 42)
  }
  finally {
    await sandbox.close()
  }
}

process.exitCode = 1
main().then(() => {
  process.exitCode = 0
}).catch(error => console.error(error))

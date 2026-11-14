import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'

const main = fileURLToPath(new URL('../../android/src/main/', import.meta.url))
function catalog(source) {
  const entries = [...source.matchAll(/<(string|plurals)\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/\1>/g)]
  const values = new Map(entries.map(([, kind, name, attributes, text]) => [name, { kind, attributes, text }]))
  assert.equal(values.size, entries.length, 'Resource names must be unique')
  return values
}
const parameters = text => [...new Set(text.match(/%\d+\$[dsf]/g) ?? [])].sort()

test('all mobile resources have matching translations and format parameters', async () => {
  const english = catalog(await readFile(join(main, 'res/values/strings.xml'), 'utf8'))
  const chinese = catalog(await readFile(join(main, 'res/values-zh/strings.xml'), 'utf8'))
  assert.deepEqual([...english.keys()].sort(), [...chinese.keys()].sort())
  for (const [name, value] of english) {
    const translated = chinese.get(name)
    assert.equal(value.kind, translated.kind, name)
    assert.deepEqual(parameters(value.text), parameters(translated.text), name)
    assert(value.text.trim() && translated.text.trim(), name)
    if (!value.attributes.includes('translatable="false"')) assert(!/\p{Script=Han}/u.test(value.text), name)
    if (value.kind === 'plurals') {
      assert.match(value.text, /quantity="one"/, name)
      assert.match(value.text, /quantity="other"/, name)
      assert.match(translated.text, /quantity="other"/, name)
      for (const item of value.text.matchAll(/<item[^>]+>(.*?)<\/item>/g)) assert.deepEqual(parameters(item[1]), parameters(translated.text), name)
    }
  }
})

async function sources(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? sources(join(directory, entry.name)) : [join(directory, entry.name)]))).flat()
}

test('native mobile copy is resource backed, with only legacy data and benchmark content excluded', async () => {
  for (const path of await sources(join(main, 'kotlin'))) {
    if (!path.endsWith('.kt') || path.endsWith('/MobileReaderBenchmark.kt')) continue
    const source = await readFile(path, 'utf8')
    assert(!source.includes('mobileLabel('), path)
    const product = source.replaceAll('已配对服务', '').replaceAll('持续输出结束标记', '')
    assert(!/\p{Script=Han}/u.test(product), path)
  }
})

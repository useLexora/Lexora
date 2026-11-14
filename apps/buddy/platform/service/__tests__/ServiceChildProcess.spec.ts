import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { expect, it } from 'vitest'
import { ServiceChildProcess } from '../ServiceChildProcess'

it.skipIf(process.platform !== 'linux')('stops the owned process group after its leader exits and preserves unrelated processes', async () => {
  let output = ''
  const child = new ServiceChildProcess({ executable: process.execPath, args: ['-e', `
    const fs = require('node:fs'); const { spawn } = require('node:child_process');
    fs.readFileSync(3);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.stdout.write(String(child.pid) + '\\n'); child.unref();
  `], env: { PATH: process.env.PATH }, output: (_stream, value) => { output += value } })
  const receipt = await child.ready({ synthetic: true })
  try {
    expect(receipt.identity.pid).toBe(child.child.pid)
    expect(receipt.identity.startIdentity).not.toBe('')
    await child.exited
    const descendant = Number(output.trim())
    expect(descendant).toBeGreaterThan(1)
    expect(await active(descendant)).toBe(true)
    await child.stopAndVerify()
    expect(await active(descendant)).toBe(false)
    expect(await active(process.pid)).toBe(true)
    await child.stopAndVerify()
  }
  finally { await child.stopAndVerify() }
})

async function active(pid: number) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]!)
  }
  catch { return false }
}

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { expect, it } from 'vitest'
import { createConcurrencyRuntime, tool } from './mutationConcurrencyFixture'

it.skipIf(process.platform !== 'linux')('exposes one command entry across real child sessions and never replays a failed selected Shell command', async () => {
  let marker = ''
  const shell = 'tests.multi-shell/bash'
  const runtime = await createConcurrencyRuntime({
    fullAccess: true,
    shells: [{
      extensionId: 'tests.multi-shell',
      revision: 'package-1',
      configurationRevision: 'configuration-1',
      preferred: ['bash'],
      candidates: [{ id: 'bash', label: 'Bash', dialect: 'bash', executable: '/bin/bash', version: '5', available: true }],
    }],
    steps: role => role === 'root' ? [tool('selected-shell', 'lexora_shell', { shell, command: `printf 'once\\n' >> '${marker.replaceAll('\'', '\'\\\'\'')}'; exit 7`, timeout: 10 })] : [],
  })
  try {
    marker = join(runtime.workspace, 'executed-once.txt')
    runtime.start()
    await runtime.complete()
    const completed = runtime.events.filter(event => event.type === 'tool.completed' && (event.payload as { toolCallId?: string }).toolCallId === 'selected-shell')
    expect(completed.map(event => event.payload)).toMatchObject([{ isError: true, presentation: { exitCode: 7 } }])
    expect(await readFile(marker, 'utf8')).toBe('once\n')
    for (const request of runtime.requests) {
      const names = request.payload.tools?.map(tool => tool.function.name) ?? []
      expect(names).toContain('lexora_shell')
      expect(names).not.toContain('bash')
      expect(names).not.toContain('powershell')
    }
    const completions = runtime.events.filter(event => event.type === 'tool.completed' && (event.payload as { toolCallId?: string }).toolCallId === 'selected-shell')
    expect(completions).toHaveLength(1)
    expect(completions[0]?.payload).toMatchObject({ isError: true })
  }
  finally {
    await runtime.dispose()
  }
}, 30000)

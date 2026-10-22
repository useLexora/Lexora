import process from 'node:process'

const mode = process.argv[2]
if (mode === 'wait') {
  setInterval(() => {}, 1_000)
}
else if (mode === 'stdout-limit' || mode === 'stderr-limit') {
  const stream = mode === 'stdout-limit' ? process.stdout : process.stderr
  stream.write('x'.repeat(2048))
}
else if (mode === 'ignored-input') {
  process.stdout.write('{}')
}
else if (mode === 'failure') {
  process.stderr.write('SYSTEM_TARGET_CHANGED')
  process.exitCode = 1
}
else {
  let input = ''
  for await (const chunk of process.stdin)
    input += chunk
  process.stdout.write(JSON.stringify({ input: JSON.parse(input), secret: process.env.BUDDY_COMMAND_TEST_SECRET ?? null }))
}

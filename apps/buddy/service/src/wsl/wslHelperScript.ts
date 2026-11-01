// The resident helper that runs searches and shell commands inside a WSL distribution. It is passed to `python3 -c` as an
// argument, so nothing is installed in the distribution and no port is opened: it talks over stdin and stdout only.
//
// Protocol (one JSON object per line, UTF-8):
//   helper -> host   {"t":"ready","v":2}                          once, when it can take requests
//                    {"id":n,"t":"o"|"e","d":"<base64>"}          a chunk of stdout or stderr of request n
//                    {"id":n,"t":"exit","code":0}                 request n ended (a negative code is a signal)
//                    {"id":n,"t":"exit","code":null,"err":"..."}  request n could not start: ENOENT, FORBIDDEN, CWD or SPAWN
//   host -> helper   {"id":n,"program":"rg","args":[...]}         start a search program
//                    {"id":n,"op":"shell","cwd":"/..","command":"..."}   run `bash -lc command`; stderr is merged into stdout
//                    {"op":"cancel","id":n}                       kill request n and its children
//
// A search can only start the programs in ALLOWED, so the helper is not a general command runner; `shell` is a separate
// operation that only the approved shell tool sends. Shell commands run with the PATH of the user's own login shell,
// probed once: `bash -lc` alone skips the interactive part of ~/.bashrc, where nvm and similar tools are set up, and
// then finds the Windows programs on the inherited PATH instead. The helper exits when stdin closes (the host went
// away), killing what is still running, and after `idle` seconds without a request.
export const WSL_HELPER_VERSION = 2

// Python 3.7 or later; anything older fails at start and the host falls back to one wsl.exe per search.
export const WSL_HELPER_SCRIPT = String.raw`import asyncio, base64, json, os, re, signal, sys

VERSION = ${WSL_HELPER_VERSION}
ALLOWED = ('rg', 'find')
IDLE = float(sys.argv[1]) if len(sys.argv) > 1 else 300.0
DEVNULL = asyncio.subprocess.DEVNULL
PIPE = asyncio.subprocess.PIPE


async def main():
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=1 << 24)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    out = sys.stdout.buffer
    procs = {}
    starting = set()
    cancelled = set()
    tasks = set()
    login_path = []
    last = [loop.time()]

    def emit(message):
        out.write((json.dumps(message, separators=(',', ':')) + '\n').encode('ascii'))
        out.flush()

    def kill(process):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass

    async def pump(id, stream, kind):
        while True:
            chunk = await stream.read(65536)
            if not chunk:
                return
            emit({'id': id, 't': kind, 'd': base64.b64encode(chunk).decode('ascii')})

    async def probe_login_path():
        try:
            process = await asyncio.create_subprocess_exec(
                'bash', '-ilc', 'printf "__PATH__%s__PATH__" "$PATH"',
                stdin=DEVNULL, stdout=PIPE, stderr=DEVNULL, start_new_session=True)
        except (OSError, ValueError):
            return None
        try:
            data, _ = await asyncio.wait_for(process.communicate(), 5)
        except asyncio.TimeoutError:
            kill(process)
            return None
        found = re.search(rb'__PATH__(.*?)__PATH__', data, re.S)
        return found.group(1).decode('utf-8', 'replace') if found else None

    def fail(id, err):
        emit({'id': id, 't': 'exit', 'code': None, 'err': err})

    # Starts a program unless a cancel arrived while it was being prepared, and reports how it ended.
    async def launch(id, program, args, **options):
        if id in cancelled:
            cancelled.discard(id)
            starting.discard(id)
            emit({'id': id, 't': 'exit', 'code': -9})
            return
        try:
            process = await asyncio.create_subprocess_exec(program, *args, stdin=DEVNULL, start_new_session=True, **options)
        except (OSError, ValueError) as error:
            starting.discard(id)
            fail(id, 'ENOENT' if isinstance(error, FileNotFoundError) else 'SPAWN')
            return
        starting.discard(id)
        procs[id] = process
        try:
            if process.stderr is None:
                await pump(id, process.stdout, 'o')
            else:
                await asyncio.gather(pump(id, process.stdout, 'o'), pump(id, process.stderr, 'e'))
            code = await process.wait()
        finally:
            procs.pop(id, None)
            last[0] = loop.time()
        emit({'id': id, 't': 'exit', 'code': code})

    async def run(request):
        id = request['id']
        program = request.get('program')
        if program not in ALLOWED:
            starting.discard(id)
            fail(id, 'FORBIDDEN')
            return
        await launch(id, program, [str(arg) for arg in request.get('args', [])], stdout=PIPE, stderr=PIPE)

    async def shell(request):
        id = request['id']
        cwd = request.get('cwd')
        if not isinstance(cwd, str) or not os.path.isdir(cwd):
            starting.discard(id)
            fail(id, 'CWD')
            return
        if not login_path:
            login_path.append(asyncio.ensure_future(probe_login_path()))
        path = await login_path[0]
        env = dict(os.environ)
        if path:
            env['PATH'] = path
        env.setdefault('TERM', 'dumb')
        await launch(id, 'bash', ['-lc', str(request.get('command', ''))], cwd=cwd, env=env, stdout=PIPE, stderr=asyncio.subprocess.STDOUT)

    async def handle(request):
        try:
            if request.get('op') == 'shell':
                await shell(request)
            else:
                await run(request)
        except Exception:
            starting.discard(request.get('id'))
            fail(request.get('id'), 'SPAWN')

    async def watch_idle():
        tick = max(0.2, min(5.0, IDLE / 4))
        while True:
            await asyncio.sleep(tick)
            if not procs and not starting and loop.time() - last[0] > IDLE:
                os._exit(0)

    emit({'t': 'ready', 'v': VERSION})
    tasks.add(asyncio.ensure_future(watch_idle()))
    while True:
        line = await reader.readline()
        if not line:
            break
        last[0] = loop.time()
        try:
            request = json.loads(line)
        except ValueError:
            continue
        if request.get('op') == 'cancel':
            id = request.get('id')
            if id in procs:
                kill(procs[id])
            elif id in starting:
                cancelled.add(id)
            continue
        starting.add(request.get('id'))
        task = asyncio.ensure_future(handle(request))
        tasks.add(task)
        task.add_done_callback(tasks.discard)
    for process in list(procs.values()):
        kill(process)


asyncio.run(main())
`

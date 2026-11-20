"""Run remaining acceptance checks serially, after the active Python suite exits."""
import json
import os
from pathlib import Path
import signal
import subprocess
import time

root = Path.cwd()
evidence = root / 'artifacts/part2-final-local-20261120'
while True:
    try:
        os.kill(45769, 0)
    except ProcessLookupError:
        break
    time.sleep(5)

example = root / 'examples/copilotkit'
steps = [
    ('runtime-serial', ['npm', 'test', '--', '--reporter=dot', '--maxWorkers=1', '--no-file-parallelism'], example, {}, 900),
    ('frontend-serial', ['npm', 'run', 'build'], example, {}, 900),
    ('browser-cloud', ['npm', 'run', 'test:e2e', '--', 'tests/browser/cloud-auth.spec.ts'], example,
     {'VITE_RUNTIME_URL': 'https://runtime.local.test', 'VITE_FIREBASE_API_KEY': 'local-browser-mock-only'}, 600),
    ('browser-serial', ['npm', 'run', 'test:e2e'], example, {}, 900),
    ('browser-graph', ['npm', 'run', 'test:e2e', '--', 'tests/browser/memory-explorer.spec.ts'], example, {'GRAPH_MEMORY_TEST': '1'}, 600),
    ('browser-dynamic', ['npm', 'run', 'test:e2e', '--', 'tests/browser/bot-management.spec.ts'], example, {'DYNAMIC_BOT_TEST': '1'}, 600),
    ('browser-multi', ['npm', 'run', 'test:e2e', '--', 'tests/browser/multi-bot.spec.ts'], example, {'MULTI_BOT_TEST': '1'}, 600),
    ('repository-check', ['python', 'scripts/check'], root, {}, 900),
]
results = []
for name, command, cwd, extra, timeout in steps:
    env = {**os.environ, **extra}
    print('START', name, flush=True)
    started = time.monotonic()
    with (evidence / (name + '.log')).open('w') as output:
        process = subprocess.Popen(command, cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=10)
            code = 124
    results.append({'step': name, 'command': command, 'exit': code, 'seconds': round(time.monotonic() - started, 2)})
    (evidence / 'serial-results.json').write_text(json.dumps(results, indent=2))
    print('DONE', name, 'exit', code, flush=True)

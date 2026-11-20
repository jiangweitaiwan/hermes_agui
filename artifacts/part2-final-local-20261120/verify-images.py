"""Bounded, serial local image builds after the final Python regression."""
import json
import os
from pathlib import Path
import signal
import subprocess
import time

root = Path.cwd()
evidence = root / 'artifacts/part2-final-local-20261120'
started = time.monotonic()
while '=== Summary:' not in (evidence / 'python-fresh-final.log').read_text():
    if time.monotonic() - started > 1200:
        raise TimeoutError('Python regression did not finish; refusing overlapping image builds')
    time.sleep(5)
time.sleep(5)
steps = [
    ('repository-check-final', ['python', 'scripts/check'], 600),
    ('host-build-serial', ['docker', 'build', '--platform', 'linux/amd64', '-f', 'Dockerfile.agui', '-t', 'hermes-agui:part2', '.'], 900),
    ('runtime-build-serial', ['docker', 'build', '--platform', 'linux/amd64', '-f', 'examples/copilotkit/Dockerfile', '-t', 'hermes-runtime:part2', 'examples/copilotkit'], 900),
]
results = []
for name, command, timeout in steps:
    print('START', name, flush=True)
    started = time.monotonic()
    with (evidence / (name + '.log')).open('w') as output:
        process = subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
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
    (evidence / 'image-results.json').write_text(json.dumps(results, indent=2))
    print('DONE', name, 'exit', code, flush=True)

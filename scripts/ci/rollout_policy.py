"""Fail closed on unreviewed schema, infrastructure and managed-release contracts."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

PREFIXES = ('.github/', 'deploy/', 'scripts/ci/', 'hermes_agui/storage/', 'hermes_agui/core/',
            'examples/copilotkit/server/storage/', 'examples/copilotkit/server/llm/')
FILES = ('Dockerfile.agui', 'examples/copilotkit/Dockerfile', 'pyproject.toml', 'uv.lock',
         'examples/copilotkit/package.json', 'examples/copilotkit/package-lock.json',
         'hermes_agui/core/managed_llm.py', 'hermes_agui/core/llm_registry.py',
         'hermes_agui/message_adapter.py', 'hermes_agui/adapter.py', 'hermes_agui/session_manager.py',
         'examples/copilotkit/server/runtime.ts', 'examples/copilotkit/server/index.ts', 'hermes_agui/host_config.py',
         'examples/copilotkit/server/bootstrap.ts')


def protected(name):
    return name in FILES or name.startswith(PREFIXES)


def check(root, baseline):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(root), *args], text=True, encoding='utf-8', timeout=30).strip()
    base = git('rev-parse', '--verify', baseline + '^{commit}')
    git('merge-base', '--is-ancestor', base, 'HEAD')
    risky = [name for name in git('diff', '--name-only', base, '--').splitlines() if protected(name)]
    if risky:
        raise ValueError('MANUAL_REQUIRED: reviewed baseline must advance for: ' + ', '.join(risky))
    files = [name for name in git('ls-tree', '-r', '--name-only', 'HEAD').splitlines() if protected(name)]
    hashes = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in files}
    return {'baseline': base, 'contract': hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', required=True)
    args = parser.parse_args()
    print(json.dumps(check(Path.cwd(), args.baseline)))


if __name__ == '__main__':
    main()

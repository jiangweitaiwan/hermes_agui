
"""Bind source contracts to a reviewed ancestor; live database checks own compatibility."""

import argparse
import hashlib
import json
import subprocess
from pathlib import Path


PREFIXES = (
    'deploy/',
    'hermes_agui/storage/migrations/',
    'examples/copilotkit/server/storage/migrations/',
)

FILES = (
    'examples/copilotkit/server/llm/control-contract.ts',
    'hermes_agui/core/managed_llm.py',
)


def protected(name):
    return name in FILES or name.startswith(PREFIXES)


def check(root, baseline):
    def git(*args):
        return subprocess.check_output(
            ['git', '-C', str(root), *args],
            text=True,
            encoding='utf-8',
            timeout=30,
        ).strip()

    base = git('rev-parse', '--verify', baseline + '^{commit}')

    git('merge-base', '--is-ancestor', base, 'HEAD')

    # Source integrity evidence is not an old-Image SQL compatibility attestation.
    # Schema drift, migration versions and releases are checked inside Cloud Run Jobs.
    files = [
        name
        for name in git('ls-tree', '-r', '--name-only', 'HEAD').splitlines()
        if protected(name)
    ]

    hashes = {
        name: hashlib.sha256(
            (root / name).read_bytes()
        ).hexdigest()
        for name in files
    }

    return {
        'baseline': base,
        'contract': hashlib.sha256(
            json.dumps(hashes, sort_keys=True).encode()
        ).hexdigest(),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', required=True)
    args = parser.parse_args()

    print(json.dumps(check(Path.cwd(), args.baseline)))


if __name__ == '__main__':
    main()

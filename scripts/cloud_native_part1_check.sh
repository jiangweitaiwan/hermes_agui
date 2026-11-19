#!/usr/bin/env bash
# Explicit acceptance entrypoints. Use only disposable, empty databases for migrate.
set -euo pipefail
cd "$(dirname "$0")/.."
mode=${1:-regression}
case "$mode" in
  migrate)
    : "${HERMES_PYTHON:?Set the PM test interpreter with agui and agui-cloud extras}"
    : "${HERMES_AGUI_TEST_DATABASE_URL:?Set a disposable EMPTY database connection string}"
    "$HERMES_PYTHON" - <<'PY'
import os
from pathlib import Path
import psycopg
with psycopg.connect(os.environ['HERMES_AGUI_TEST_DATABASE_URL'], autocommit=True) as conn:
    for root in ('hermes_agui/storage/migrations', 'examples/copilotkit/server/storage/migrations'):
        for path in sorted(Path(root).glob('*.sql')):
            conn.execute(path.read_text(), prepare=False)
            print('Applied', path)
PY
    ;;
  regression)
    : "${HERMES_PYTHON:?Set the PM test interpreter}"
    : "${HERMES_AGUI_TEST_DATABASE_URL:?Set the migrated disposable test database}"
    : "${HERMES_AGUI_TEST_RUNTIME_DATABASE_URL:?Set the Node PG connection URL for the same database}"
    : "${HERMES_AGUI_TEST_DB_SOCKET:?Set the disposable local PostgreSQL Unix socket directory}"
    (cd examples/copilotkit && npm test -- --reporter=dot --maxWorkers=1)
    "$HERMES_PYTHON" -m tests.hermes_agui.postgres_storage_probe
    HERMES_TEST_FILE_RETRIES=0 scripts/run_tests.sh -j "${HERMES_TEST_WORKERS:-2}" tests/hermes_agui
    (cd examples/copilotkit && npm run build && node --import tsx tests/fixtures/wiki-evaluate.ts && node --import tsx tests/fixtures/wiki-evaluate.ts --postgres)
    ;;
  browser)
    (cd examples/copilotkit && npm run test:e2e)
    (cd examples/copilotkit && GRAPH_MEMORY_TEST=1 npm run test:e2e -- tests/browser/memory-explorer.spec.ts)
    (cd examples/copilotkit && DYNAMIC_BOT_TEST=1 npm run test:e2e -- tests/browser/bot-management.spec.ts)
    (cd examples/copilotkit && MULTI_BOT_TEST=1 npm run test:e2e -- tests/browser/multi-bot.spec.ts)
    ;;
  container)
    docker build -f Dockerfile.agui -t hermes-agui:part1 .
    docker build -f Dockerfile.agui.part1-test -t hermes-agui:part1-test .
    docker build -f examples/copilotkit/Dockerfile -t hermes-runtime:part1 examples/copilotkit
    HERMES_TEST_FILE_RETRIES=0 scripts/run_tests.sh -j 1 --file-timeout 600 tests/hermes_agui/test_cloud_native_restart.py -m integration
    ;;
  *) echo 'Usage: scripts/cloud_native_part1_check.sh migrate|regression|browser|container' >&2; exit 2 ;;
esac

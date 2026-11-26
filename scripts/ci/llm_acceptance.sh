#!/usr/bin/env bash
# One shared environment/PG cluster for the Python, Node, PG and browser gates.
set -euo pipefail
: "${HERMES_PYTHON:?PM-built test interpreter required}"
: "${AGUI_LLM_TEST_ADMIN_URL:?Disposable PostgreSQL required}"
: "${HERMES_AGUI_TEST_DB_SOCKET:?Disposable PostgreSQL Unix socket required}"
: "${CI_EVIDENCE_DIR:?}"
mkdir -p "$CI_EVIDENCE_DIR"
export AGUI_LLM_TEST_HOST_PYTHON="$HERMES_PYTHON"
export COPILOTKIT_TELEMETRY_DISABLED=true DO_NOT_TRACK=1
"$HERMES_PYTHON" -c 'import ag_ui, psycopg, psycopg_pool, pytest'
"$HERMES_PYTHON" - <<'PY'
import os
from pathlib import Path
from urllib.parse import urlsplit
value = urlsplit(os.environ['AGUI_LLM_TEST_ADMIN_URL'])
if value.hostname not in ('127.0.0.1', 'localhost') or value.username != 'hermes' or value.path != '/postgres':
    raise SystemExit('Only the dedicated local CI PostgreSQL cluster is permitted')
socket = Path(os.environ['HERMES_AGUI_TEST_DB_SOCKET'])
if not socket.is_absolute() or not socket.is_dir():
    raise SystemExit('Existing Python PG contracts require a real Unix socket directory')
PY

"$HERMES_PYTHON" -m scripts.ci.migration_gate > "$CI_EVIDENCE_DIR/migrations.json"
# Existing Host/Graph fixtures use the shared disposable postgres DB. The
# independent control/browser suites still create their own random databases.
AGUI_HOST_DATABASE_URL="$AGUI_LLM_TEST_ADMIN_URL" \
  "$HERMES_PYTHON" -m hermes_agui.storage.migrate
(cd examples/copilotkit && AGUI_RUNTIME_DATABASE_URL="$AGUI_LLM_TEST_ADMIN_URL" \
  node --import tsx server/storage/migrate-cli.ts)
scripts/run_tests.sh tests/hermes_agui tests/scripts/test_llm_image_rollout.py \
  tests/scripts/test_llm_release_manifest.py tests/scripts/test_cicd_integrity.py \
  -m 'not integration' -j 2
cd examples/copilotkit
npm test -- --reporter=dot --maxWorkers=2 --testTimeout=15000
npm run build
node --import tsx --input-type=module - <<'JS' > "$CI_EVIDENCE_DIR/code-contract.json"
import { SnapshotSchema, hash, taskManifest } from './server/llm/control-contract.ts';
process.stdout.write(JSON.stringify({
  accepted_release_contracts: SnapshotSchema.shape.contract.options,
  task_fingerprint: hash(taskManifest())
}));
JS
npm test -- --config vitest.llm-control.config.ts --reporter=verbose
./node_modules/.bin/playwright test --config playwright.llm-control.config.ts
./node_modules/.bin/playwright test tests/browser/chat.spec.ts tests/browser/graph-routing.spec.ts
GRAPH_MEMORY_TEST=1 ./node_modules/.bin/playwright test tests/browser/graph-v2.spec.ts tests/browser/memory-explorer.spec.ts
# A failed registry request is a failed security gate, never a clean scan.
npm audit --audit-level=high --json > "$CI_EVIDENCE_DIR/npm-audit.json"
cd ../..
"$HERMES_PYTHON" -m scripts.ci.python_audit > "$CI_EVIDENCE_DIR/python-audit.txt" 2>&1
echo 'Full acceptance completed; not a deployment approval.'

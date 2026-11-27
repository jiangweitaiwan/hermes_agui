#!/usr/bin/env bash
set -euo pipefail
: "${HERMES_PYTHON:?}" "${AGUI_LLM_TEST_ADMIN_URL:?}" "${HERMES_AGUI_TEST_DB_SOCKET:?}" "${CI_EVIDENCE_DIR:?}" "${COMPATIBILITY_BASE_COMMIT:?}"
mkdir -p "$CI_EVIDENCE_DIR"
export AGUI_LLM_TEST_HOST_PYTHON="$HERMES_PYTHON"
export HERMES_TEST_FILE_RETRIES=0 COPILOTKIT_TELEMETRY_DISABLED=true DO_NOT_TRACK=1
"$HERMES_PYTHON" - <<'PY'
import os
from urllib.parse import urlsplit
from pathlib import Path
v=urlsplit(os.environ['AGUI_LLM_TEST_ADMIN_URL'])
if v.hostname not in ('127.0.0.1','localhost') or v.username!='hermes' or v.path!='/postgres':
    raise SystemExit('Disposable local PostgreSQL only')
if not Path(os.environ['HERMES_AGUI_TEST_DB_SOCKET']).is_dir():
    raise SystemExit('Disposable PostgreSQL socket required')
import ag_ui, psycopg, psycopg_pool, pytest
PY
# Match the generated artifact packaged by Dockerfile.agui, including future task changes.
(cd examples/copilotkit && node --import tsx --input-type=module -e 'import {hash,taskManifest} from "./server/llm/control-contract.ts"; console.log(JSON.stringify({taskFingerprint:hash(taskManifest())}));' > ../../hermes_agui/core/llm_task_contract.json)
"$HERMES_PYTHON" -m scripts.ci.rollout_policy --baseline "$COMPATIBILITY_BASE_COMMIT" > "$CI_EVIDENCE_DIR/policy.json"
"$HERMES_PYTHON" -m scripts.ci.migration_gate > "$CI_EVIDENCE_DIR/migrations.json"
AGUI_HOST_DATABASE_URL="$AGUI_LLM_TEST_ADMIN_URL" "$HERMES_PYTHON" -m hermes_agui.storage.migrate
(cd examples/copilotkit && AGUI_RUNTIME_DATABASE_URL="$AGUI_LLM_TEST_ADMIN_URL" node --import tsx server/storage/migrate-cli.ts)
scripts/run_tests.sh tests/hermes_agui/test_server.py tests/hermes_agui/test_runtime_entrypoint.py \
  tests/hermes_agui/test_http_lifecycle.py tests/hermes_agui/test_storage_migrations.py \
  tests/scripts/test_llm_image_rollout.py tests/scripts/test_llm_release_manifest.py \
  tests/scripts/test_cicd_integrity.py -j 2
cd examples/copilotkit
npm run build
npm test -- tests/runtime.test.ts tests/cloud.test.ts tests/llm-registry.test.ts tests/llm-managed-startup.test.ts --maxWorkers=2
npm test -- --config vitest.database-deployment.config.ts
node --import tsx --input-type=module - <<'JS' > "$CI_EVIDENCE_DIR/code-contract.json"
import { SnapshotSchema, hash, taskManifest } from './server/llm/control-contract.ts';
process.stdout.write(JSON.stringify({accepted_release_contracts: SnapshotSchema.shape.contract.options, task_fingerprint: hash(taskManifest())}));
JS
cd ../..
"$HERMES_PYTHON" - <<'PY'
import json, os, subprocess
from pathlib import Path
from scripts.ci.llm_release_manifest import OFFLINE_GATES
p=Path(os.environ['CI_EVIDENCE_DIR'])
p.joinpath('offline-ci.json').write_text(json.dumps({
 'commit':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),
 'gates':dict.fromkeys(sorted(OFFLINE_GATES),'PASS'),
 'code_contract':json.loads(p.joinpath('code-contract.json').read_text()),
 'policy':json.loads(p.joinpath('policy.json').read_text()),
 'limitations':'Local disposable PG, fixture inference. Full acceptance/security scans are separate; no production DDL.'
},indent=2)+'\n')
PY

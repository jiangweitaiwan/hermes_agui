# LLM Unification — Part 1 report

## Status and scope

Branch `codex/graph-memory-v2`; reviewed HEAD and plan baseline both
`820b9f4c1624a4ed5511374113114360155b8eb4`. Part 1 code and offline acceptance are implemented.
**Production/cloud acceptance is blocked, not passed:** no real Vertex ADC/model quota run, real PostgreSQL/GCS
migration run, or Cloud Run rollout/rollback drill was performed. **Part 2 was not executed.**

Existing user changes were preserved: six deleted prior Graph reports, modified `tests/runtime.json`, and the
untracked input plan. They are excluded from the delivered [Part 1 diff](llm-unification-part-1.diff).
No SQL migration, table wipe, evidence/ACL rewrite, Bot identity migration or cloud deployment was performed.

## Deliverables and implementation

- [Caller inventory](llm-call-inventory.md): whole-repository REST/SDK/AST scan, native auxiliary/child/background,
  Graph stage/embedding, setup/readiness probes, proxy forwarding and non-text/non-LLM classification. Includes
  caller functions, input, auth, deadlines, execution, fallback, deployment and test/disposition mapping.
- TS `server/llm/config.ts`: strict versioned Provider/Model registry; `taskRegistry` binds existing stages to roles,
  output schema v1 and `legacy` prompt/validator identifiers. No Part 2 prompt registry was introduced.
- Python `hermes_agui/core/llm_registry.py`: same trusted JSON model, strict validation and canonical SHA-256;
  cross-language test compares actual Python/TS fingerprints from the shared deployment JSON.
- TS bootstrap and worker bootstrap select the same config; native Host config/static Bots/managed templates bind
  registry roles at construction. Optional `llmFingerprint` rejects artifact mismatch before startup. Template
  `model_role`/`modelRole` are admin-only; browser Bot schemas still reject routing overrides.
- Python keeps the native provider resolver/Agent loop. Vertex project/region and request deadline are bound by
  ContextVars to the owning turn, including refresh; compatible-provider credentials are captured by trusted Host
  loading into redacted fields. Native retry/token caps use the selected role. Existing sessions retain their
  cached native Agent/route; no mid-turn prompt/tool mutation or cross-language LLM RPC was added.
- TS `providers/vertex.ts`: ADC/refreshable OAuth, native `generateContent` + generated JSON schema; native embedding
  `predict`, one instance/request, ordered batches, dimensionality/finite/nonzero/truncation checks. Explicit Gemini
  allowlist; regional embedding only. Request/cancel/body-size limits, 429/5xx retry classification and sanitized
  HTTP errors; unexpected output and auth errors do not silently select another vendor.
- TS `providers/openai-compatible.ts`: registry-selected OpenRouter/OpenAI JSON-object and embedding wire support;
  generated schema supplies format constraints and Zod validates response. Legacy `OpenAICompilerLLM`,
  `OpenAIEncoder`, `CompilerLLM` and `Encoder` entry contracts remain available with their old behavior.
- Central `llm/schema/`: parser, matcher decisions, relations, query, story and legacy compiler output Zod entities.
  Internal consumers import the actual definitions (no internal re-export shims). Deterministic supported-subset
  transformer fails on unsupported types; refinements, regex/identity/evidence/span/integrity checks remain
  server-side. Domain/persistence schemas, ID/hash/provenance creation and ACL authority remain separate.
- Wiki/V2-edge/V3-narrative embedding keys include registry provider identity/endpoint (Vertex project/region),
  model, dimension, version, task/normalization and template policy. Legacy tuple keys remain unchanged.
  New spaces never query old spaces. The administrator `vectors` CLI now fills missing batches without clearing
  older spaces; outages/missing vectors retain lexical fallback. No index data is deleted by this migration path.
- [Deployment/reindex/rollback guide](llm-unification-deployment.md), opt-in Host/Runtime Vertex examples, shared
  registry JSON and generated editor JSON schema. Original OpenRouter deployment examples remain unchanged.

### Deliberate constraints

New and legacy routing fields for an activated path are rejected rather than guessed. Graph fallbacks are
explicit one-hop allowlists and only follow retryable errors. Native registry Agent roles currently require an
**empty fallback allowlist**; unrelated profile fallbacks are disabled on that route. Legacy native behavior is
unchanged when registry is absent. Auxiliary models remain governed by native `auxiliary` configuration; they
are inventoried and are not claimed to inherit every Graph/primary setting automatically.

The active embedding selector is immutable startup configuration. Candidate rows can be built before switching
revision traffic; rollback selects the old config and old keys. There is no new distributed DB active-pointer
coordinator. Per-service config switch is atomic; coordinating Host/Runtime/Worker revisions remains an explicit
operational gate. This limitation is not represented as a tested cloud-wide atomic switch.

## Tests and observed failures

All external inference in executed tests used local scripted providers. The Graph integration uses real native
Hermes conversation output → SessionIngestor → real worker/parser/relation domain processing and publication →
SQLite wiki/edge vectors → query/MemoryNet/story, plus real HTTP Vertex-format transport, ambiguity matcher path,
provider outage and lexical/grounded fallbacks. It uses the existing Chinese meeting fixture, UTF-16 evidence
validation, actor separation and real persisted evidence; it is more than a successful-JSON adapter mock.

| Command / environment | Observed result |
|---|---|
| Initial default `npm test -- --reporter=dot` | Node failed before collection: macOS libc++ symbol missing |
| Retry with installed Node 20 | 28 files failed; no `node:sqlite`; one timeout; not a code baseline pass |
| Node 22 sandbox run | socket `listen EPERM`, plus timeouts; not counted passed |
| Pristine HEAD archive, Node 22, 4 workers/default 5 s | 3 failures: two timeouts and missing Python verifier path in archive; retained as original failures |
| Pristine HEAD archive, matching environment, `npm test -- --reporter=dot --maxWorkers=2 --testTimeout=15000` | **160 passed, 25 skipped**, 25 files passed/8 skipped; archive linked existing Python venv |
| Final full Graph suite, same command | **171 passed, 27 skipped**, 27 files passed/9 skipped; includes final parity, legacy budget validation and matcher/native→Graph changes |
| Final targeted `npm test -- tests/llm-registry.test.ts tests/llm-vertex-flow.test.ts tests/llm-embedding-durable.test.ts --reporter=verbose` | **11 passed, 2 skipped**; includes shared Python/TS fingerprint, actual native→Graph path and matcher ambiguity |
| `scripts/run_tests.sh tests/hermes_agui/test_llm_registry.py tests/hermes_agui/test_headless_agent.py tests/agent/test_vertex_adapter.py` with isolated homes and explicit existing `.venv/bin/python` | **18 passed, 0 failed** (registry then had 3 tests, native headless 7, Vertex 8) |
| Final `scripts/run_tests.sh tests/hermes_agui/test_llm_registry.py` | **4 passed, 0 failed**, including template positional API and managed prepare/restore |
| `tsc --noEmit -p examples/copilotkit/tsconfig.json` | passed; rerun after final changes recorded with evidence |
| Final legacy config + parity regression (`graph-v3-config.test.ts`, `llm-registry.test.ts`) | **11 passed**, 2 files passed |
| Scoped `check_no_tmp_literals.py` on new source/docs/examples | passed; no new literal scratch-path violations |
| `ruff check --preview` on changed Python files | passed |
| `python scripts/check --base HEAD --only health` | initially 3 new TS complexity violations; extracted helpers; rerun **0 blocking, 0 advisory** |
| Full `python scripts/check` / `--base HEAD` | final **16/17 checks pass**; only `no-tmp` fails on 6 pre-existing hits: four in prior `artifacts/graph-memory-v2-part-1/verification/*.txt`, two in local `host-config.yaml`; new Vertex YAML hits fixed; unrelated files untouched |
| Dynamic Host regression file `test_dynamic_host.py` in earlier broader Python run | **collection blocked** by missing `ag_ui` dependency in existing venv; not reported as passing; direct new provisioner prepare/restore test passes |
| Live Vertex smoke | **SKIPPED / not executed**: no explicitly supplied live test config/ADC/quota acceptance |
| Real PostgreSQL + GCS embedding migration/rollback test | **SKIPPED / not executed**: no disposable test DSN + bucket acceptance configuration |

Earlier new native tests initially failed because a tool-free fake call was classified as auxiliary, then because
profile-scoped secret reads did not see a process-only fixture key. Fixed the fixture to use real native tools and
fixed production credential ownership to capture Host-owned keys explicitly; final native tests pass. One automatic
permission review timed out before starting a test command; the permitted retry succeeded. This was not a test pass
or an unsafe-action finding.

### Reproduction

The system Node could not run; an official Node 22.16.0 Darwin x64 distribution was downloaded to temporary scratch
for verification. Set PATH to that executable's directory (or use a supported installed Node) and run:

```sh
# examples/copilotkit
npm test -- --reporter=dot --maxWorkers=2 --testTimeout=15000
npm test -- tests/llm-registry.test.ts tests/llm-vertex-flow.test.ts tests/llm-embedding-durable.test.ts --reporter=verbose
./node_modules/.bin/tsc --noEmit
```

```sh
# repository root; select isolated scratch directories for both environment variables
HERMES_HOME="$TEST_HOME" HERMES_RUNTIME_DIR="$TEST_RUNTIME" HERMES_PYTHON="$PWD/.venv/bin/python" scripts/run_tests.sh tests/hermes_agui/test_llm_registry.py tests/hermes_agui/test_headless_agent.py tests/agent/test_vertex_adapter.py
python scripts/check --base HEAD
```

Test socket/process checks required sandbox escalation; no real model or deployed service was contacted.
Final command logs and a [machine-readable result summary](../artifacts/llm-unification-part-1/results.json) accompany this report under
`artifacts/llm-unification-part-1/`. Skipped tests are kept separate from passed tests.

## Remaining gates / next-stage risks

1. **Do not roll out from mocked evidence alone.** Run real Vertex native Hermes and TS structured/embedding smoke,
   IAM/quota/region availability, expiring-token behavior, worker and retrieval smoke in staging.
2. Run real PG/GCS migration and Cloud Run revision rollback with existing source revocation, competing workers,
   pending jobs and immutable object generations. New vector keys preserve data; this does not prove cloud rollout.
3. Existing 750 ms vector deadlines are intentionally retained. Sequential single-instance Vertex embedding batches
   can fall back frequently; measure latency before enabling production semantic recall. Do not increase interactive
   deadlines to match ingest timeouts.
4. Native auxiliary overrides, local runtime probes, third-party plugins and proxy forwards intentionally retain
   their published routing policies; review actual enabled profile configuration before changing the primary model.
5. Native registry fallback is intentionally restricted. Extending it needs native resolver/credential-pool/session
   tests, not reuse of the TS graph retry loop.
6. Zod/provider schema support is a format boundary, not evidence truth. Part 2's prompt versioning, semantic verdicts,
   evidence uncertainty and domain/persistence validation pipeline remain future work; no acceptance claim is made.
7. Python/TS parsers share JSON and parity tests but remain separate implementations; expand invalid-config parity
   fixtures when adding drivers or fields. Do not add credentials to the shared object or logs.
8. Repo-wide lint baseline and missing optional Python AG-UI SDK must be resolved/verified in the supported CI test
   environment. Preserve the user's unrelated changes when preparing a commit.

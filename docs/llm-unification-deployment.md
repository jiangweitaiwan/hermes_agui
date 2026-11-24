# Part 1 registry deployment and rollback

This is an opt-in configuration change. Existing `deploy/gcp/host.example.yaml` and `runtime.example.json`
remain legacy OpenRouter examples. New `host.vertex.example.yaml` and `runtime.vertex.example.json` show the
same version-1 `llm` object. `llm-registry.vertex.example.json` is the standalone artifact to copy into both.
`llm-registry.schema.json` is generated from the TypeScript Zod config, not a hand-maintained model list.

Do not deploy these examples verbatim. Replace project, service endpoints and identities. Keep all existing
Firebase/Host/Runtime identities, principal/project/Bot IDs, tokens, DB DSNs, GCS bucket/prefix, Tasks queue,
completion and reconcile settings. This change has **no SQL migration** and does not delete persisted data.

## Configuration contract

`llm.version=1`; `providers[]` have unique `id`, `driver` and explicit capabilities. Vertex requires
`project`, `location`, `auth: adc`; compatible HTTP providers require a validated `baseUrl` and **key env name**
`keyEnv`. Keys, SA JSON contents and access tokens do not belong in this object. Models have unique `alias`,
provider ID, model ID, `timeoutMs`, `retries`, `maxTokens`, and explicit `fallback` list; embedding also requires
`dimension` and `version`. Unknown fields/providers/roles, dangling references, incompatible capability,
unsupported Vertex models, missing location/project, duplicate aliases, embedding fallback and invalid
budgets fail startup validation. Additional aliases must be referenced as explicit one-hop fallback targets.

Roles: `agent_primary`, `graph_parser`, `graph_matcher`, `graph_relations`, `graph_query`, `graph_story`,
`graph_embedding`. Part 1 bound Graph tasks to schema version 1 and `legacy` prompt/validator identifiers.
Part 2 now binds immutable prompt version `1` and validator version `1`; model/provider config version remains `1`.
See [Part 2 deployment/review/rollback SOP](llm-unification-part-2-operations.md) for the additional rollout gates.

When `llm` is absent, existing Bot `model/provider`, `graph.evolution.compiler`, `graph.queryParser`,
`graph.storyteller` and `graph.embedding` work unchanged. When a registry role activates a path, remove the
corresponding legacy routing fields. Mixed config is rejected, never silently resolved to a different vendor.
The ingest CLI also accepts `{registry: <llm-object>, role: "graph_parser"}` as `compiler`, and analogous
`graph_embedding` as `embedding`, retaining existing legacy shapes.

Host templates choose `model_role`; Runtime templates choose `modelRole`. Remove legacy `model`, `provider`,
`api_key_env` and `base_url` for those templates. Browser `BotInput` / Host `BotSpec` still cannot select model,
provider, role, credentials, namespace or ACL. Template IDs remain unchanged. Host captures compatible-provider
credentials at trusted config load and passes them through redacted fields, without reading another profile's
ambient environment during a turn. Direct Python `AgentConfig` callers supply `llm_registry`, `model_role`
and a redacted `llm_credentials={ENV_NAME: secret}` mapping; Vertex needs no credential value there.

Python uses native Hermes resolver and `agent/vertex_adapter.py`, including token refresh and scoped project/
region. It does not use TypeScript or an LLM proxy. Registry Agent routes reject nonempty fallback lists;
this explicit fail-closed restriction prevents inheriting unrelated profile fallback providers. Native auxiliary
settings remain native; inventory their profile `auxiliary` overrides before changing a production Bot.

Graph stage calls retry only HTTP 429/5xx within the role's **overall** deadline; malformed output/auth/validation
errors do not cause vendor fallback. Only declared one-hop fallback aliases are used. Cancellation bounds token
mint, transport and response reads. Query/Story retain existing outer deadlines, grounded/lexical fallback,
and ingest retains claim/lease/overall timeout. Embedding has no provider fallback.

## Cloud Run identities and rollout gate

Use the platform Service Account ADC/Workload Identity; no fixed bearer token and no mounted SA JSON in production.
Local ADC can use `gcloud auth application-default login`; a deliberately supplied local credentials file follows
Google ADC conventions. Grant `roles/aiplatform.user` on the selected inference project only to services that call it:

| Workload | Model work |
|---|---|
| Host native Agent and Host run workers | native chat; separately configured native auxiliary work |
| Runtime | interactive query/story, retrieval embedding, local evolution only when enabled |
| Graph Worker / one-shot ingest worker | parser/matcher/relations, wiki and edge embeddings |
| Completion / Reconcile / Scheduler | existing delivery duties; no new inference duty or job added |

Existing Storage/SQL/Tasks/Firebase permissions remain necessary and unchanged. Region/model availability and
quota must be checked in staging. Chat allowlist currently covers Gemini 2.5 Flash/Pro; native Graph driver uses
`generateContent` + `responseJsonSchema`. Embedding allowlist is regional `gemini-embedding-001`, 1..3072 dimensions,
one text per request, symmetric `SEMANTIC_SIMILARITY`, no truncation. Global embedding is rejected. Large batches
may exhaust existing 750 ms retrieval/index bounds and safely return lexical results; measure staging latency.

Compute/log canonical fingerprint with `new ModelRegistry(llm).fingerprint` or Python
`fingerprint(parse_registry(llm))`. Host, Runtime and Worker log the same secret-free fingerprint. Pin the expected
value as top-level `llmFingerprint` on each service; mismatch refuses startup. This checks each artifact, **not** a
cross-service distributed lock. Verify all revision fingerprints before enabling traffic and job delivery.

1. Back up existing config/revision identifiers and consistent DB/GCS references. Keep the old images/config.
2. Validate candidate config and IAM in staging. Run mocked suite, optional live Vertex smoke and **separate** real
   PostgreSQL/GCS migration test. Neither skipped test is acceptance evidence.
3. Build candidate fingerprint indexes using the existing administrator CLI `vectors` command with the candidate
   `embedding` role config and desired namespace/retrieval mode. It now fills missing batches without clearing old
   spaces. Re-run until no missing rows/failures; inspect wiki and edge metrics. Do not use rebuild/delete as rollout.
4. Active fingerprint is selected by immutable startup config, not by an LLM. Switch a prepared Cloud Run revision's
   traffic/config atomically per service, coordinating Host/Runtime/Worker to the same artifact. Until all services
   are verified, pause/drain delivery using existing operational controls. No new coordinator/table is introduced.
5. Run worker-job smoke, retrieval/story smoke, tenant isolation and revoked-source checks, then enable delivery.

Vectors use new keys containing provider identity/endpoint (Vertex project/location), model, dimension, version,
task/normalization policy and separate wiki/V2-edge/V3-narrative templates. Legacy encoders retain their exact old
key tuples. No query ever searches another encoder's key. A not-yet-built/outage candidate yields lexical results.

Rollback: send traffic back to old revisions/config and restore old Worker selector; retain current tables, old
vector keys, object generations, job ledger and source/evidence pointers. There is no schema rollback and no Graph
wipe. Removal of obsolete index spaces remains a separate, reviewed administrator operation. The existing legacy
`VectorIndex.rebuild` API is still an explicit destructive admin operation; migration CLI no longer calls it.

## Verification commands

Run from `examples/copilotkit` with Node >=22.13 supporting `node:sqlite`:

```sh
npm test -- --reporter=dot --maxWorkers=2 --testTimeout=15000
./node_modules/.bin/tsc --noEmit
```

Run Python only through the repository runner:

```sh
scripts/run_tests.sh tests/hermes_agui/test_llm_registry.py tests/hermes_agui/test_headless_agent.py tests/agent/test_vertex_adapter.py
python scripts/check --base HEAD
```

Optional real Vertex: set **test-only** `AGUI_VERTEX_SMOKE_CONFIG` to a trusted registry JSON file, configure ADC,
and run `npm test -- tests/llm-vertex-flow.test.ts`. It incurs model usage. Without the file it is explicitly skipped.
Real durable test additionally needs disposable `HERMES_AGUI_TEST_RUNTIME_DATABASE_URL`, `AGUI_GCS_BUCKET` and ADC:
`npm test -- tests/llm-embedding-durable.test.ts`. It retains immutable test data under a random tenant; cleanup is a
separate scoped operation. This test cannot establish a Cloud Run traffic rollback drill by itself.

Regenerate the editor schema from repository root:

```sh
node --import ./examples/copilotkit/node_modules/tsx/dist/loader.mjs examples/copilotkit/server/llm/export-config-schema.ts
```

Google API references: [structured output](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/control-generated-output),
[GenerationConfig JSON schema field](https://docs.cloud.google.com/java/docs/reference/google-cloud-vertexai/latest/com.google.cloud.vertexai.api.GenerationConfig.Builder),
[text embedding predict contract](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/get-text-embeddings).

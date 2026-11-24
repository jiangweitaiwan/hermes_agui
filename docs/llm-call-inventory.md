# Production LLM / Embedding caller inventory

Reviewed branch `codex/graph-memory-v2`, HEAD `820b9f4c1624a4ed5511374113114360155b8eb4`.
Inventory includes repository-owned production paths, not arbitrary external skills, MCP servers or installed plugins.
Part 2 is excluded. Names below refer to final code; baseline routing was checked with `git log -p -S OpenAICompilerLLM`.

## Search and classification

Searched the whole repository (not just the plan's file list) for `fetch(`, `/chat/completions`, `/embeddings`,
`responses`, `generateContent`, `generate_content`, `api_key`, `model`, `provider`, `OpenAI`, `Anthropic`, `Gemini`,
`Vertex`, plus Python AST calls to SDK constructors/completion methods and auxiliary dispatchers.
Excluded `node_modules`, generated assets, tests, evals from **production** classification, but inspected test/eval fixtures for contracts.
AST conversion helpers named `converse_*`, string `.encode()`, SQLite `fetch`, Slack/Google Chat `messages.create`,
GitHub skill `fetch`, package downloads, credentials/OAuth/catalog requests are not inference.

Notation: A = native foreground turn; B = native auxiliary; G = Graph structured stage; E = Graph embeddings;
N = native adapter/probe; M = non-text model; X = non-LLM network. Every grouped call inherits the table's input,
authentication, deadlines, sync/background and fallback contract. Appendix lists individual Python caller functions.

## Hermes production dispatch and auxiliary paths

| Class / files and functions | Input / purpose | Authentication and budget | Execution / fallback / service | Part 1 disposition / tests |
|---|---|---|---|---|
| A: `hermes_agui/core/factory.py::_create_agent`, `core/service.py::run`, `host.py::load_host`, `provisioner.py::prepare`, `storage/host_runs.py::_configure` | trusted Bot template/profile + session history → native AIAgent | legacy resolver unchanged; new `agent_primary` selects custom API-key env captured by Host or Vertex ADC; role timeout, token cap, native retry count | synchronous loop in owned worker; same session cached agent; immutable routing per construction; registry native fallback must be empty (ambient fallback disabled); Host | new registry/role bridge for static/dynamic and durable `replace(source,...)` paths; `tests/hermes_agui/test_llm_registry.py`, existing `test_headless_agent.py`, `test_dynamic_host.py` |
| A/N: `agent/turn_api_request.py`, `turn_api_call.py`, `chat_completion_helpers.py::_dispatch_nonstreaming_api_request/_open_chat_stream`, `chat_completion_headers.py`, `transports/*`, `client_lifecycle.py` | tool/history/messages → assistant/tool response | provider credentials/pools, per-provider/model timeout (default legacy 1800 s), SDK and native retry policy | sync + streaming helper threads; native configured fallback chain; CLI/TUI/Host/gateway/desktop/ACP | preserve native loop, tool surface and cache; registry only selects route, no mid-session hot swap |
| N: `agent/vertex_adapter.py::get_vertex_config/vertex_access_token`, `hermes_cli/runtime_provider.py::_resolve_vertex_runtime` | Vertex OpenAI-compatible chat routing/token mint | ADC or explicit local SA; project/region scope; refreshable token; scoped registry overrides ambient project/region | native resolver and 401 refresh; Host/all native surfaces | added ContextVar route, not TS proxy; `tests/agent/test_vertex_adapter.py`; existing `tests/e2e/core/providers/test_native_vertex_*.py` remain native wire tests |
| N: `agent/anthropic_adapter.py`, `gemini_native_adapter.py::_GeminiCompletions`, `bedrock_adapter.py::call_converse`, `codex_runtime.py::_open_codex_stream`, `codex_responses_adapter.py`, `acp_client.py`, `moa_loop.py`, `relay_llm.py` | normalize vendor messages/tools/streams, MoA reference+aggregate | native API key/OAuth, AWS SigV4, subprocess ACP, relay; native provider timeouts (Gemini legacy read default 1200 s, Anthropic read 900 s); token budgets from request | native adapters; existing retry, thought-signature and fallback behavior; all native surfaces | retained; not replaced by new Graph drivers; Bedrock context-length probe also makes inference |
| A: `tools/delegate_tool.py::_run_single_child`, `agent/curator.py` review agent, `agent/background_review.py`, `cron/scheduler.py` agent construction, `batch_runner.py`, `gateway/session_execution.py`, `session_cold_review.py`, `run_background.py`, `run_turn_hygiene.py`, `session_tui_side.py`, `tui_gateway/agent_factory.py`, `methods_prompt.py`, `plugins/platforms/feishu/feishu_comment.py`, CLI background/session helpers | delegated, scheduled, curator/review and normal turns → same AIAgent loop | A scoped native credentials/config, independent task/turn budgets | child/background/CLI/cron/gateway, existing native fallback | production constructors found beyond the initial plan; retained, not assumed to inherit new Graph roles; `hermes_cli/prompt_size.py` constructs an Agent for sizing, not itself proof of inference |
| N: `hermes_cli/auth_zai_kimi.py::_probe_single_zai_endpoint`, `azure_detect.py`, `doctor_connectivity.py`, `fallback_check.py`, `web_routers/config_env.py` provider probes, `local_runtime/supervisor.py::touch_generate` | setup/auth/readiness/connectivity requests, some actually generate tokens | explicit selected-provider credentials; ZAI probe default 8 s, doctor Anthropic 10 s, local readiness default 300 s/512 tokens, other probe-owned deadlines | setup/doctor/local-runtime readiness; failure selects existing probe fallback or reports unavailable | retained; zero-token transport probes distinguished from billable generation; not new Graph tasks |
| N: `hermes_cli/proxy/server.py`, proxy adapters `xai.py`/`nous_portal.py`; `gateway/wake.py`, `run_turn.py`; native API-server/OpenAI routes | forward chat/responses/**embeddings** or resume an Agent session | existing proxy OAuth/API auth and request deadlines, loopback/server identity | stream/passthrough; existing auth refresh/allowlisted routes | real production inference forwarding, no local embedding encoder; not routed to new Graph registry |
| B: `agent/auxiliary_client.py::call_llm/async_call_llm/get_text_auxiliary_client`, `auxiliary_*`, `plugin_llm.py` | common side-model API, plugin `ctx.llm` | profile-scoped native auxiliary task settings + explicit provider/model overrides; key/OAuth/native client, auxiliary timeout/retry/deadline | sync/async/background; existing task fallback chains and hook accounting; all native surfaces | inventoried, native config retained; **not** silently forced through `agent_primary` or Graph registry |
| B: `agent/context_compressor.py::_call_summary_llm`, `context_compressor_summary.py`, `micro_compaction.py::_micro_summarize_one`, `prepared_compaction.py`, `conversation_compression*.py`, `trajectory_compressor.py::_generate_summary/_generate_summary_async` | summarize conversation/trajectory | B, compression deadline/task config; trajectory standalone also supports caller-supplied SDK client | sync/async/background; existing summary fallback, pruning contract unchanged | deliberately retained; compression is sole sanctioned prompt-prefix mutation |
| B: `agent/title_generator.py::generate_title`, `agent/oneshot.py::run_oneshot` | title or one-shot instructions | B, explicit task timeout/cap | background title / synchronous one-shot; native fallback | retained; new native test verifies main-history stability |
| B: `tools/vision_tools.py::_call_vision_llm/stage`, `tools/computer_use/tool.py` | image/video frames and visual action reasoning | B vision or backend-native credentials and caller budget | async tool, existing provider capability/fallback | retained, multimodal paths distinguished from Graph text |
| B: `tools/approval_smart.py::_smart_approve`, `mcp_tool_sampling.py::_build_llm_call`, `kanban_tools.py::_goal_judge_available` | approval decision, MCP sampling, goal judge | B (approval cap 16; caller/config deadlines); MCP sampling model preferences validated by existing code | sync/async tool work; existing fail-closed approval/caller policies | retained; no new core tools |
| B: `hermes_cli/goals.py::_call_goal_judge_llm`, `kanban_specify.py::_call_aux`, `profile_describer.py::describe_profile`, `kanban.py::_goal_mode_handoff_rejection` | goal/spec/profile descriptions | B explicit task/model/deadline | CLI/background; existing native task fallback | retained |
| B: `tui_gateway/hosted_room_router_call.py::ask_router`, `cron/scripts/classify_items.py::main`, `plugins/memory/query_rewrite.py::rewrite_memory_query` | room routing, scheduled classification, memory recall query rewrite | B profile task config, native credentials, per-caller deadline | room background / cron / memory plugin; existing failure contracts | retained, includes callers outside initial plan's file list |
| M: `tools/transcription_cloud.py`, `tts_streaming.py`, `tts_tool_providers.py`, `voice_live.py`, `plugins/image_gen/*`, image/video provider plugins | ASR/TTS/realtime audio/image/video generation; TTS rewrite is B | native provider/plugin credentials and media timeout/cap | tool/stream/backend; existing plugin failure policies | inventory only; non-text output not migrated to Graph structured client |
| X/N: `plugins/model-providers/*`, model metadata/catalog/context probes, plugin memory services | provider discovery/probe; memory SaaS remote processing is opaque | existing service authentication, scoped provider settings | native provider registration / remote services | retain provider-plugin API; no core→specific-plugin imports; catalog calls aren't completions; real inference probes listed as N |

No repository-native production Python embedding **encoder** was found by the SDK/REST scan; the authenticated proxy does forward `/embeddings` and is inventoried above. Python string
encoding, model capability labels and remote memory-service internals must not be represented as Graph embeddings.
Graph owns the explicit production embedding transport below. Remote memory backends can embed internally;
that behavior is outside this repository and is not evidence of Vertex compatibility.

## Graph production callers

| Stage / file / function | Input → purpose | Auth / timeout / execution / fallback | Deployment / disposition / tests |
|---|---|---|---|
| `compiler.ts::OpenAICompilerLLM.json`, `WikiCompiler.analyze/merge/compile` | source chunks/claims/proposals → legacy analysis/generation/merge | legacy env-key `/chat/completions`, 30 s default, max 120 s, 4096 tokens default, JSON object, 128 KiB response; 120 s overall job with lease heartbeat | Runtime evolution / Worker / ingest CLI; bridge retained; registry also registers three legacy stages; `wiki-ingest`, `wiki-evolution` tests |
| `parser.ts::parseSource`, `compiler-v2.ts::compileV2` | untrusted source → subjects/narratives/stable attributes; UTF-16 quotes | G `graph_parser`; old compiler config maps to same legacy client; registry stage role uses independent deadline/cap/retries; job overall bound retained | Runtime/Worker/CLI; Stage schema moved, existing evidence checks remain; `graph-v2.test.ts`, `llm-vertex-flow.test.ts` |
| `subject-matcher.ts::resolveSubjects` | lexical ambiguous identities/candidates → decisions | G `graph_matcher`, only when deterministic matching unresolved; failure fails/retries existing job, no silent identity merge | same ingest services; centralized decision schema; `graph-v2.test.ts`, registry routing tests |
| `relation-abstractor.ts::abstractRelations` | parsed narratives/subjects → relation proposals | G `graph_relations`; server creates persisted IDs/hash/time/evidence/ACL | same ingest services; centralized relation schema; Graph fixture tests + Vertex mock HTTP |
| `wiki-rewriter.ts`, `wiki-merger.ts`, `temporal-resolver.ts`, `query-temporal-resolver.ts` | domain construction, append/merge and time resolution | **deterministic**, no provider credentials or LLM call | retained unchanged; no Part 2 algorithm changes |
| `evolution.ts::loadEvolution/MemoryEvolution.tick/processJob`, `session-ingestor.ts::enqueue`, `worker-cli.ts`, `ingest-cli.ts::work` | durable/local completion/job source → compiler | selects G client; foreground worker or background timer; session-ingestor itself doesn't infer; claim/lease/fail policy unchanged | Runtime timer locally; Cloud Tasks Worker; one-shot completion/reconcile/worker jobs bootstrap same config; factories now support both legacy and role config |
| `query-parser.ts::QueryParser.parse`, `provider.ts::loadWiki/loadDurableWiki` | untrusted query → retrieval intent plan | G `graph_query`; legacy 2 s default, schema max 30 s; role deadline additionally bounded by caller; malformed/timeout returns existing query fallback | interactive Runtime; centralized QueryPlanSchema; `graph-v3-config`, `graph-v3-net`, new registry/flow tests |
| `memory/storyteller.ts::tell`, `story-validator.ts`, `v3-orchestrator.ts`, `pipeline.ts` | authorized MemoryNet → reordered evidence-backed claims | G `graph_story`; existing 1.5 s deadline, concurrency 2, deterministic grounded fallback; validators retain authority | Runtime; centralized StorySchema; existing storyteller/runtime tests + Vertex HTTP outage test |
| `embedding.ts::OpenAIEncoder.embed`, `VectorIndex.update/search` | wiki section/query → symmetric vectors | E legacy `/embeddings`, API key env; 500 ms default, <=1 s config, caller retrieval bound 750 ms; indexing retries existing, search failure → lexical | Runtime/Worker/CLI; legacy key tuple remains byte-identical; registry uses explicit provider/endpoint/model/dimension/version/template fingerprint |
| `edge-embedding.ts::EdgeVectorIndex.update/encode/search` | V2 edge JSON or V3 narrative text / query → vectors | E `graph_embedding`; 750 ms caller bound; source/evidence validity recheck after remote await; missing/outage → lexical, no cross-key vector comparison | same services; separate wiki/V2/V3 template keys; no table/column changes; `wiki-hybrid`, `graph-v2-retrieval`, new durable migration test |
| `llm/providers/vertex.ts::VertexStructuredLLMClient.generate` | trusted instruction + schema, separate user payload → normalized JSON | ADC OAuth refresh via google-auth-library; explicit project/region/model allowlist; native `generateContent`, JSON schema; bounded token mint/read/abort; 429/5xx only retries; no hidden provider fallback | new opt-in Graph driver; `llm-registry.test.ts`, `llm-vertex-flow.test.ts`; live smoke skipped unless explicitly configured |
| `llm/providers/vertex.ts::VertexEmbeddingClient.embed` | texts → native predict vectors | ADC; gemini-embedding-001; one instance/request, ordered bounded batch <=32; `SEMANTIC_SIMILARITY`, `autoTruncate:false`, dimension/truncation validation; role retries within overall deadline | new opt-in E driver; fingerprint includes task/normalization policy; durable real PG/GCS test is conditional, never counted passed when skipped |
| `llm/providers/openai-compatible.ts` | trusted schema/instruction or texts → JSON/vectors | registry env-key; independent role deadline/retries; `/chat/completions` JSON-object bridge with generated schema; `/embeddings` verifies model, indices, dimension, finite/nonzero values; redirect denied | preserves OpenAI/OpenRouter; old entry classes retain original wire behavior |
| `runtime.ts::singleHandler/createHermesAgent`, `cloud.ts`, Bot Host clients, Graph objects/Tasks/storage | AG-UI forwarding, Google ID token HTTP, GCS/DB/Tasks | **not LLM**; runtime CopilotRuntime sets `generativeUI:false`; server forwards to native Hermes | no CopilotKit side OpenAI completion client; preserve Host/Runtime/Worker/Tasks/Scheduler topology |

## Registry and vector migration boundary

The trusted deployment `llm` object is identical JSON in Python Host, TS Runtime and Worker. Strict bilingual parsers,
role/capability checks and canonical SHA-256 fingerprints detect invalid or mismatched configurations. Optional
`llmFingerprint` pins the expected artifact on each service. New and legacy routing on an activated path is rejected;
absence of `llm` preserves legacy behavior. Static and dynamic Bot roles come only from server templates.

The active embedding selector is the immutable, process-start config. Candidate config builds missing rows under its
new fingerprint without deleting existing rows. Publish/switch that config through Cloud Run revision traffic;
rollback selects old config/keys. An empty or unavailable candidate space returns lexical results, never old-space
vectors. There is **no new database-wide active-pointer coordinator**; coordinated service rollout and real PG/GCS
acceptance remain deployment gates. Reindex does not imply deleting old spaces.

## Python caller appendix (AST audit)

Each completion below inherits A/N/B/M contracts above. SDK client constructors are listed as constructors, not
extra requests. Conversion-only Converse AST matches were removed. A runtime provider/plugin can introduce additional
calls after installation; this is a repository snapshot inventory, not an assertion about remote implementation internals.

| File | Function | Dispatch |
|---|---|---|
| `agent/oneshot.py` | `run_oneshot` | `call_llm` |
| `agent/moa_loop.py` | `_run_reference` | `call_llm` |
| `agent/moa_loop.py` | `aggregate_moa_context` | `call_llm` |
| `agent/chat_completion_headers.py` | `_chat_completion_capturing_headers` | `client.chat.completions.create` |
| `agent/context_compressor.py` | `_call_summary_llm` | `call_llm` |
| `agent/plugin_llm.py` | `_invoke_sync` | `call_llm` |
| `agent/plugin_llm.py` | `_invoke_async` | `async_call_llm` |
| `agent/auxiliary_client.py` | `_create_openai_client` | `OpenAI` |
| `agent/auxiliary_client.py` | `create` | `self._client.responses.create` |
| `agent/auxiliary_client.py` | `create` | `call_converse` |
| `agent/auxiliary_client.py` | `_relay_sync_stream` | `client.chat.completions.create` |
| `agent/auxiliary_client.py` | `_to_async_client` | `AsyncOpenAI` |
| `agent/auxiliary_client.py` | `_build_bedrock_client` | `OpenAI` |
| `agent/auxiliary_client.py` | `_create_with_progress_once` | `client.chat.completions.create` |
| `agent/auxiliary_client.py` | `_acreate_with_stream` | `client.chat.completions.create` |
| `agent/auxiliary_client.py` | `_acreate_with_progress` | `client.chat.completions.create` |
| `agent/auxiliary_client.py` | `_call_llm_impl` | `client.chat.completions.create` |
| `agent/codex_runtime.py` | `_open_codex_stream` | `active_client.responses.create` |
| `agent/chat_completion_helpers.py` | `_dispatch_nonstreaming_api_request` | `_bedrock_converse_call` |
| `agent/chat_completion_helpers.py` | `_dispatch_nonstreaming_api_request` | `agent.client.chat.completions.create` |
| `agent/chat_completion_helpers.py` | `_finalize_bedrock_relay_events` | `stream_converse_with_callbacks` |
| `agent/chat_completion_helpers.py` | `_open_stream` | `_bedrock_converse_call` |
| `agent/chat_completion_helpers.py` | `_fall_back_to_converse` | `client.converse` |
| `agent/chat_completion_helpers.py` | `_worker` | `stream_converse_with_callbacks` |
| `agent/chat_completion_helpers.py` | `_open_chat_stream` | `request_client.chat.completions.create` |
| `agent/title_generator.py` | `generate_title` | `call_llm` |
| `agent/bedrock_adapter.py` | `normalize_converse_stream_events` | `stream_converse_with_callbacks` |
| `agent/bedrock_adapter.py` | `call_converse` | `client.converse` |
| `agent/bedrock_adapter.py` | `probe_bedrock_context_length` | `client.converse` |
| `agent/micro_compaction.py` | `_micro_summarize_one` | `call_llm` |
| `agent/conversation_compression.py` | `check_compression_model_feasibility` | `get_text_auxiliary_client` |
| `tools/vision_tools.py` | `_call_vision_llm` | `async_call_llm` |
| `tools/vision_tools.py` | `stage` | `async_call_llm` |
| `tools/transcription_cloud.py` | `_with_openai_client` | `OpenAI` |
| `tools/tts_tool_providers.py` | `_rewrite_with_auxiliary_model` | `call_llm` |
| `tools/approval_smart.py` | `_smart_approve` | `call_llm` |
| `tools/mcp_tool_sampling.py` | `_build_llm_call` | `call_llm` |
| `tools/tts_streaming.py` | `stream` | `OpenAI` |
| `tools/kanban_tools.py` | `_goal_judge_available` | `get_text_auxiliary_client` |
| `plugins/memory/query_rewrite.py` | `rewrite_memory_query` | `call_llm` |
| `hermes_cli/goals.py` | `_call_goal_judge_llm` | `call_llm` |
| `hermes_cli/kanban_specify.py` | `_call_aux` | `call_llm` |
| `hermes_cli/profile_describer.py` | `describe_profile` | `call_llm` |
| `hermes_cli/kanban.py` | `_goal_mode_handoff_rejection` | `get_text_auxiliary_client` |
| `tui_gateway/hosted_room_router_call.py` | `ask_router` | `call_llm` |
| `cron/scripts/classify_items.py` | `main` | `call_llm` |
| `trajectory_compressor.py` | `_init_summarizer` | `OpenAI` |
| `trajectory_compressor.py` | `_get_async_client` | `AsyncOpenAI` |
| `trajectory_compressor.py` | `_generate_summary` | `call_llm` |
| `trajectory_compressor.py` | `_generate_summary` | `self.client.chat.completions.create` |
| `trajectory_compressor.py` | `_generate_summary_async` | `async_call_llm` |
| `trajectory_compressor.py` | `_generate_summary_async` | `self._get_async_client().chat.completions.create` |

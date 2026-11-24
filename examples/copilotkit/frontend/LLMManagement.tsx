import { useCallback, useEffect, useState } from "react";

interface Model { alias: string; provider: string; model: string; timeoutMs: number; retries: number; maxTokens: number; fallback: string[]; dimension?: number; version?: string }
interface Registry { version: number; providers: unknown[]; models: Model[] }
interface Draft { config: Registry; revision: number; generation: number; release_id: string }
interface Provider { id: string; driver: string; models: string[]; modelsByRole:Record<string,string[]>;credentialAvailable: boolean | null }
interface Release { release_id: string; release_fingerprint: string; created_by: string; created_at: string; reason: string }
interface Validation { candidateHash: string; revision: number; generation: number; diff: Model[]; issues: string[] }
interface Audit { request_id:string;action:string;actor:string;created_at:string;old_release:string|null;new_release:string|null }
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`/api/admin/llm/${path}`, { method, credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    if (response.status === 409) throw new Error("設定已由其他管理員更新，請重新載入草稿。");
    if (response.status === 401 || response.status === 403) throw new Error("需要 deployment administrator 權限。");
    if(response.status===422){const body=await response.json();throw new Error(body.error??"草稿驗證失敗。");}
    throw new Error(`操作未完成 (${response.status})`);
  }
  return response.json();
}
const group = (role: string) => role === "agent_primary" ? "Agent" : role === "graph_embedding" ? "Embedding" :
  ["graph_query", "graph_story"].includes(role) ? "Retrieval" : "Ingest";
interface EmptyDraftProps {busy:boolean;hasDraft:boolean;error:string}
function EmptyDraft({busy,hasDraft,error}:EmptyDraftProps){
  return !busy && !hasDraft && !error ? <p>尚未建立 release；請由可信 CLI 匯入。</p> : null;
}
const activationText=(mode?:string)=>mode==="managed"?"新工作將使用此版本；既有工作保持原 pin。":"目前為 static；發布僅更新控制面，工作仍使用啟動設定，需啟用 managed 才生效。";

export function LLMManagement() {
  const [tab, setTab] = useState("Tasks"), [draft, setDraft] = useState<Draft>();
  const [providers, setProviders] = useState<Provider[]>([]), [releases, setReleases] = useState<Release[]>([]);
  const [active, setActive] = useState<{ mode: string; roles:string[];active: { release_id: string; release_fingerprint: string; snapshot: { tasks: unknown } } }>();
  const [validation, setValidation] = useState<Validation>(), [error, setError] = useState("");
  const [status, setStatus] = useState(""), [busy, setBusy] = useState(false), [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState<{ action: "publish" | "rollback"; target?: string }>();
  const [next, setNext] = useState<string | null>(null);
  const [events,setEvents]=useState<Audit[]>([]);
  const load = useCallback(async () => {
    setBusy(true); setError(""); setValidation(undefined);
    try {
      const [d, p, h, a] = await Promise.all([api("draft"), api("providers"), api("releases"), api("tasks")]);
      setDraft(d); setProviders(p); setReleases(h.releases); setNext(h.next); setEvents(h.events);setActive(a);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function perform(run: () => Promise<void>) {
    setBusy(true); setError(""); setStatus("");
    try { await run(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function change(alias: string, patch: Partial<Model>) {
    if (!draft) return;
    setValidation(undefined);
    setDraft({ ...draft, config: { ...draft.config, models: draft.config.models.map(model => model.alias === alias ? { ...model, ...patch } : model) } });
  }
  return <section aria-label="LLM Management">
    <h2>LLM Management</h2>
    <p>模式：{active?.mode ?? "尚未載入"} · Control plane Active：{active?.active.release_id ?? "—"}</p>
    <p>{activationText(active?.mode)}</p>
    <code>{active?.active.release_fingerprint}</code>
    <nav aria-label="LLM tabs">{["Tasks", "Providers", "Releases"].map(name =>
      <button key={name} onClick={() => setTab(name)} aria-current={tab === name ? "page" : undefined}>{name}</button>)}</nav>
    <button disabled={busy} onClick={() => void load()}>重新載入</button>
    {busy && <p role="status">處理中…</p>}{error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
    <EmptyDraft busy={busy} hasDraft={!!draft} error={error}/>
    {tab === "Tasks" && draft && <>
      <p>草稿 revision {draft.revision} · Active generation {draft.generation}。Embedding、Prompt、Schema、Validator 唯讀。</p>
      {["Agent", "Ingest", "Retrieval", "Embedding"].map(name => <fieldset key={name} disabled={busy}>
        <legend>{name}</legend>{draft.config.models.filter(model => active?.roles.includes(model.alias) && group(model.alias) === name).map(model =>
          <fieldset key={model.alias} disabled={name === "Embedding"}><legend>{model.alias}</legend>
            <label>Provider<select value={model.provider} onChange={e => {
              const provider = providers.find(p => p.id === e.target.value)!;
              change(model.alias, { provider: provider.id, model: provider.modelsByRole[model.alias][0] });
            }}>{providers.filter(p=>p.modelsByRole[model.alias]?.length).map(p => <option key={p.id}>{p.id}</option>)}</select></label>
            <label>Model<select value={model.model} onChange={e => change(model.alias, { model: e.target.value })}>
              {(providers.find(p => p.id === model.provider)?.modelsByRole[model.alias] ?? []).map(m => <option key={m}>{m}</option>)}
            </select></label>
            {(["timeoutMs", "retries", "maxTokens"] as const).map(key => <label key={key}>{key}<input type="number" value={model[key]}
              onChange={e => change(model.alias, { [key]: Number(e.target.value) })} /></label>)}
            <label>Fallback（逗號分隔 alias）<input value={model.fallback.join(",")} disabled={name === "Agent"}
              onChange={e => change(model.alias, { fallback: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })} /></label>
            {name === "Embedding" && <p>dimension {model.dimension} · version {model.version}</p>}
          </fieldset>)}</fieldset>)}
      <button disabled={busy} onClick={() => void perform(async () => {
        const result = await api("draft", "PATCH", { expectedRevision: draft.revision, config: draft.config });
        setDraft({ ...draft, revision: result.revision }); setValidation(undefined); setStatus("草稿已儲存，尚未發布。");
      })}>儲存草稿</button>
      <button disabled={busy} onClick={() => void perform(async () => {
        setValidation(await api("validate", "POST", {}));
      })}>驗證已儲存草稿</button>
      {validation && <div><h3>Active → Candidate diff</h3><pre>{JSON.stringify(validation.diff, null, 2)}</pre>
        <code>{validation.candidateHash}</code><p>{validation.issues.length ? validation.issues.join(" / ") : "驗證通過"}</p>
        <button disabled={busy || validation.issues.length > 0} onClick={() => setConfirmation({ action: "publish" })}>發布</button></div>}
      <details><summary>唯讀 code contracts</summary><pre>{JSON.stringify(active?.active.snapshot.tasks, null, 2)}</pre></details>
    </>}
    {tab === "Providers" && <>{providers.map(provider => <article key={provider.id}><h3>{provider.id}</h3>
      <p>{provider.driver} · Credential：{provider.credentialAvailable === null ? "ADC（需真實驗收）" : provider.credentialAvailable ? "已掛載" : "尚未掛載"}</p>
      <p>{[...new Set(provider.models)].join(", ")}</p><button disabled={busy || !draft} onClick={() => void perform(async () => {
        const result = await api("providers/test", "POST", { providerId: provider.id, draftRevision: draft!.revision });
        setStatus(`${provider.id}: ${result.status}, ${result.latencyMs} ms`);
      })}>Synthetic probe</button></article>)}<p>供應商／Secret reference 由部署 allowlist 管理。切換 vendor 前須確認資料傳送授權。</p></>}
    {tab === "Releases" && <>{!releases.length && <p>沒有 release。</p>}{releases.map(release => <article key={release.release_id}>
      <h3>{release.release_id}</h3><code>{release.release_fingerprint}</code><p>{release.created_by} · {release.created_at} · {release.reason}</p>
      <button disabled={busy} onClick={() => setConfirmation({ action: "rollback", target: release.release_id })}>回滾至此版本</button>
    </article>)}{next && <button disabled={busy} onClick={() => void perform(async () => {
      const history = await api(`releases?before=${encodeURIComponent(next)}`); setReleases([...releases, ...history.releases]); setNext(history.next);
    })}>載入更多</button>}<h3>管理 Audit</h3>{events.map(event=><p key={event.request_id}>
      {event.action} · {event.actor} · {event.created_at} · {event.old_release ?? "—"} → {event.new_release ?? "—"}
    </p>)}</>}
    {confirmation && <div role="dialog" aria-modal="true" aria-label="確認 release 操作">
      <p>確認 {confirmation.action} {confirmation.target ?? validation?.candidateHash}。{activationText(active?.mode)}</p>
      <p>確認已授權向所選 Provider 傳送資料。</p><label>原因<input value={reason} onChange={e => setReason(e.target.value)} /></label>
      <button disabled={busy || !reason.trim()} onClick={() => void perform(async () => {
        if (confirmation.action === "publish") await api("releases", "POST", { expectedGeneration: validation!.generation,
          draftRevision: validation!.revision, candidateHash: validation!.candidateHash, reason });
        else await api("rollback", "POST", { target: confirmation.target, expectedGeneration: draft!.generation, reason });
        setConfirmation(undefined); setReason(""); await load(); setStatus("後端已確認操作成功。");
      })}>確認</button><button disabled={busy} onClick={() => setConfirmation(undefined)}>取消</button>
    </div>}
  </section>;
}

/** Historical snapshots are readable only by the upgrade tool, never by Runtime. */
import { canonical, ModelRegistry } from "./config";
import { candidate, ControlError, hash, verifySnapshot } from "./control-contract";
import { promptRegression } from "./prompt-regression";
import type { ControlStore, Release } from "./control-store";

export function historical(row: Release) {
  const raw = row.snapshot as any;
  // Check the persisted value/shape before normalization. Corruption is not incompatibility.
  if (!raw || hash(raw) !== row.release_fingerprint || raw.version !== 1 ||
      !["management-part-1", "management-part-2"].includes(raw.contract) ||
      hash(raw.tasks) !== raw.taskFingerprint || raw.taskFingerprint !== row.task_fingerprint ||
      new ModelRegistry(raw.llm).fingerprint !== raw.modelFingerprint || raw.modelFingerprint !== row.model_fingerprint) {
    throw new ControlError(503, "Release integrity failure; restore verified data before upgrading");
  }
  const fields = ["version","contract","llm","modelFingerprint","taskFingerprint","tasks",
    ...(raw.contract === "management-part-2" ? ["prompts","codeTaskFingerprint"] : [])].sort();
  if (canonical(Object.keys(raw).sort()) !== canonical(fields) ||
      (raw.contract === "management-part-2" && (!raw.prompts || !/^[a-f0-9]{64}$/.test(raw.codeTaskFingerprint)))) {
    throw new ControlError(503, "Unknown historical release shape");
  }
  return raw;
}

/** Runs during the fenced maintenance window. Insert + pointer + draft + audit are atomic.
 * A failed transaction never leaves a prepared orphan or an ambiguous pointer.
 */
export async function upgradeRelease(store: ControlStore, baseline: unknown) {
  return store.transaction(async client => {
    if(!(await client.query("SELECT (closed AND jobs_closed) AS closed FROM hermes_agui_runtime.deployment_fence WHERE singleton")).rows[0]?.closed) {
      throw new ControlError(503,"Release deployment requires a closed maintenance fence");
    }
    const prior = (await client.query(`SELECT r.*,a.generation FROM hermes_agui_runtime.llm_active_release a
      JOIN hermes_agui_runtime.llm_releases r USING(scope,release_id) WHERE a.scope=$1`, [store.policy.scope])).rows[0];
    if (!prior) {
      // Bootstrap has the same advisory lock, but needs its own transaction.
      return { status: "EMPTY" as const };
    }
    const raw = historical(prior);
    const next = candidate(raw.llm, store.policy, raw.prompts ?? {});
    const draft = (await client.query(`SELECT * FROM hermes_agui_runtime.llm_drafts WHERE scope=$1`, [store.policy.scope])).rows[0];
    if (!draft) throw new ControlError(503, "Active release has no draft; restore verified state");
    if (hash(next) === prior.release_fingerprint) {
      verifySnapshot(raw, prior.release_fingerprint, store.policy);
      return { status: "CURRENT" as const, release_id: prior.release_id };
    }
    // Preserve unpublished edits too; reject removed task keys and policy changes explicitly.
    const nextDraft = candidate(draft.config, store.policy, draft.prompts ?? {});
    if (!promptRegression().passed) throw new ControlError(422, "Upgrade prompt safety regression failed");
    const id = `release-upgrade-${hash({parent: prior.release_id, snapshot: next})}`;
    await store.insert(client, next, "system:deployment", "Release contract upgrade", prior.release_id, id);
    await client.query(`UPDATE hermes_agui_runtime.llm_active_release SET release_id=$1,generation=generation+1,
      updated_by='system:deployment',updated_at=clock_timestamp() WHERE scope=$2`, [id,store.policy.scope]);
    await client.query(`UPDATE hermes_agui_runtime.llm_drafts SET config=$1,prompts=$2,revision=revision+1,
      updated_by='system:deployment',updated_at=clock_timestamp() WHERE scope=$3`, [nextDraft.llm,nextDraft.prompts,store.policy.scope]);
    await store.audit(client,"publish","system:deployment","Release contract upgrade",prior.release_id,id);
    return { status: "UPGRADED" as const, release_id: id, parent: prior.release_id };
  }).then(async result => {
    if (result.status !== "EMPTY") return result;
    const initialized=await store.bootstrap(baseline,"system:deployment",true);
    return {status:initialized.applied?"BOOTSTRAPPED" as const:"CURRENT" as const,release_id:(await store.active()).release_id};
  });
}

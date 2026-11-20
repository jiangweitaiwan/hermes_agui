# Manual Cloud Run source package

See [deployment instructions](../../docs/cloud-run-deployment.md) for the complete parameter and command reference.
No deployment automation is included. See the [latest local acceptance report](../../docs/cloud-native-part-2-final-acceptance.md).
Images and three entrypoint startup checks pass locally with SDK doubles; the complete L01–L10 gate has not passed. Real cloud tests remain NOT RUN.

| Artifact | Consumer |
|---|---|
| `host.example.yaml` | Host `--bots-config` parser |
| `runtime.example.json` | Runtime and Worker `AGUI_BOTS_CONFIG` / bootstrap |
| `host.env.example` | Host and Host one-shot jobs |
| `runtime.env.example` / `worker.env.example` | Node Runtime / Worker |
| `frontend.env.example` | Vercel Vite build; public values only |
| `database-grants.sql` | Schema owner, after Host 001–006 and Runtime 001–008 |
| `compose.staging.yaml` | Optional operator-run staging composition; NOT RUN |

Copy examples to `host.yaml`, `runtime.json`, `host.env`, `runtime.env`, `worker.env`; replace all placeholders.
Never commit populated secret files. Compose requires a separate disposable PostgreSQL cluster, prepared roles/grants,
service DSNs pointing to `postgres:5432`, a mounted ADC credential and operator-provided GCS access.
It does not emulate IAM, Firebase, Tasks or GCS, and cannot establish cloud correctness.

Cloud SQL pool sizing: Host pool max 4; Runtime has registry, thread and Graph pools (each max 4);
Worker uses the same composition. Limit max instances against DB capacity, reserve migration/admin headroom,
and include scheduled jobs in the budget. Do not turn up instance counts without a connection budget.

Backup/restore: freeze new writes; preserve PG consistent backup and every referenced GCS generation together.
Restore into isolated DB/bucket, retain original object keys and generations, compare profile manifests/checksums
and Graph revision pointers before allowing traffic. No object GC is shipped. Keep unreferenced objects at least
seven days and retain all referenced generations. Never apply a bucket lifecycle rule that removes referenced history.
Local PG17 dump/restore and profile-manifest checks pass with filesystem object doubles; see the acceptance report.
Real GCS/PITR restore and image rollback drills remain NOT RUN.

Rollback: new migrations are additive. Roll back image/config only while retaining the expanded schema and
migration ledger. Do not drop columns/tables or restore an older DB independently of objects. Back up before migration.
Fresh deployment is the accepted Part 1 scope. An existing Part 1 database without a migration ledger must apply
only Host 006 / Runtime 008 manually with its schema owner; do not run the fresh migrators against it.

Runtime commits a job and delivery row before best-effort Tasks enqueue. Scheduler retries pending or expired jobs;
DB claim tokens and fencing decide publication. Task creation ACK loss can produce duplicates. Terminal failed/cancelled
jobs are acknowledged because their reason is persisted. An administrator can inspect a failed job and reset its
state/attempt/availability for a deliberate retry; do not replay external tool side effects automatically.
Scheduler must invoke Worker reconciliation and the independent Host completion/reconcile jobs. No reliability
claim depends on post-response timers or SIGTERM delivery. The compiler stops before the configured task deadline;
long work needs chunking or a separate Jobs design.

Never print environment dumps, tokens, service credentials, prompt bodies or connection URLs in logs. Restrict log
access and inspect redacted job/run status. The SDK and provider transports must not be put in verbose wire-log mode.

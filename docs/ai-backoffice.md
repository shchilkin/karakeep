# AI workspace and cloud controls

The owner's requested backoffice lives in Karakeep: `/dashboard/ai` for owned
cards and batches, `/admin/ai` for the same workspace plus administrator-only
cloud controls. It deploys with the web/worker image. It does not require another
service. General batches govern **Media AI catalog analysis**; imported images
also have a separate classification-only panel described below. In the deployed
hybrid configuration, legacy inference and embedding clients are disabled; this
is not a network firewall for arbitrary plugins or separately configured apps.

## Contract

- Cloud mode is Off, Manual only, or Automatic. Defaults preserve existing
  configuration. Off holds unsent cloud work; local admission and local sensitive
  cataloging continue. Manual only admits explicit single/bulk requests. Existing
  automatic producer configuration and user preferences still apply.
- Only administrators change the global mode and daily request limit. Edits use an
  optimistic revision. The runtime limit cannot exceed the environment ceiling.
  Usage counts durable UTC-day reservations, including failures and uncertain
  attempts. It is neither a currency budget nor a count of successful cards.
- A single card, selected cards, or a filtered result can be prepared as a batch,
  capped at 200. Preparation snapshots owned IDs, target provider/model, content
  and policy revisions, and fingerprints. It performs no inference. Confirmation
  starts that fixed batch; later matching cards never join it. Skip reasons are
  visible. Deferred imports without an existing catalog permit remain held.
- The configured cloud provider is fixed; a batch can choose a model supported by
  that provider or local-only cataloging. This does not change global model
  defaults. Unknown/unsupported model names fail visibly at the provider; no
  silent provider fallback occurs. Selecting a model never bypasses local
  admission or Sensitive routing. Display settings do not allow cloud transfer.
- The worker reads runtime controls before claiming and immediately before cloud
  dispatch, including after media preparation. Pausing a batch holds its queued
  work. Cancellation prevents pending work from starting. An already dispatched
  request may finish and is still counted. A reserved attempt interrupted before
  dispatch is cancelled rather than automatically replayed by resume.
- Batch entries form a durable outbox. Delivery and recovery use the same run ID.
  Queue retries cannot issue the same reserved cloud attempt twice. A new explicit
  refresh creates a new attempt and warns when the previous attempt was reserved.
  Periodic recovery pages through waiting work so earlier paused batches do not
  permanently starve later eligible work.
- Successful results record provider, requested and API-resolved model (when
  returned), completion date, catalog version, content revision and sampled media
  count. Local generator revision/recipe and classifier model/revision/policy are
  separate. History retains prior attempts, while a failed refresh retains the
  previously applied result. Manual titles, notes and tags are preserved.
- Filters cover missing description, error, active/successful state, provider and
  model, successful-analysis date, and inputs/version needing review. The latter
  flags changed content revision, stale state, old catalog version, or missing
  historical version metadata; it does not assert that every legacy result is
  wrong. Legacy completion dates and model identities are never invented.

## Imported images: local Sensitive batches

The separate panel on `/dashboard/ai` prepares either selected owned imported
images or all committed imports owned by the caller. Only committed imports count
toward the snapshot; unrelated selected cards and unavailable IDs are not included.
Preparation does not release processing. Review the counts and skip reasons, then
confirm **Start local checks**. This is ShieldGemma's native `sexual`, `dangerous`
and `violence` classification, not a precise `explicit_sexual` detector.

- The fixed server-side snapshot is capped at 50,000 imports (not 200). Larger
  selections fail rather than silently truncating. The browser receives aggregates
  and 50-row result pages. New imports never join an existing batch.
- Only verified JPEG/PNG/GIF/WebP originals up to **50 MiB** with an existing
  preview qualify. The 1 GiB import admission limit is separate. Videos, PDFs and
  native text/link cards are skipped. Existing checks/analysis checkpoints,
  failures and active processing are never automatically repeated or overwritten.
- Confirmation releases **only `local_check`** through the existing revision and
  generation fences. It includes cumulative **search indexing of existing titles
  and source tags**, disclosed before confirmation. It cannot release `catalog`,
  generate Qwen descriptions, reserve a cloud request or download source media.
  Source metadata, retained originals and manual labels remain unchanged.
- One running or paused batch per owner; at most one outstanding batch admission
  globally. The existing worker/queue retains its normal scheduling controls.
  Pause stops new admissions; an already admitted item may finish. Resume processes
  remaining ready entries, not failed entries. Durable intent and cursor are
  committed atomically, so polling/restarts do not create a second release.
- Failures pause remaining work. Inspect the paged entries before resuming.
  Classification-only recovery does not re-dispatch failed or uncertain model
  attempts; an undispatched pending job can retain its deduplicated queue key.
  `complete` means the snapshot is drained, **not** that skipped/failed files were
  successfully checked. A paused batch is not automatically resumed.
- Local admission requires enabled Media AI, hybrid support and local `enforce`
  mode. The normal 200-card captioning batch and its catalog permissions do not
  change. API procedures are owner-scoped under `deferredImport` / `imports`.

Migration `0104_import_local_check_batches` adds normalized batch/item tables.
Deploy with the normal backup/migration/canary gate before running a small,
explicitly approved real pilot. Deployment alone does not prepare or start a batch.

Validation: `importLocalCheckBatches.test.ts` exercises the authenticated API and
durable admission controller, including >200 selections, pauses, owner isolation,
failures and stale permits. `ImportLocalCheckBatches.test.tsx` uses actual tRPC
React hooks with a fake HTTP service for review/start/pause/resume and paged results.
`importLocalCheckBatch.integration.test.ts` runs the real API, SQLite queue,
retained filesystem assets, FFmpeg and workers against synthetic classifier/search
adapters. It verifies no cloud/caption dispatch, no paid reservation, preserved
originals and no automatic retry of an unknown result. These are local tests, not
production or real-GPU acceptance evidence.

## Bounds and follow-up

History is recorded from this release onward; the previous current state is
retained when first refreshed. The UI shows the latest 30 runs per card and latest
20 batches per owner. No archive-wide backfill, paid inference, provider changes,
GPU cutover or migration is triggered by deploying this feature.

Manual sets and embedding-based set suggestions remain a separate workstream.
General catalog batches queue existing cards and never create sets or grant import
permits. Only the separate local-check panel can grant the restricted release above.
Group imports before granting individual catalog permits if avoiding
separate analyses is the goal. Media sampling remains the existing bounded recipe;
coverage metadata does not imply exhaustive video or carousel inspection.

Migration `0101_ai_backoffice` adds three tables and leaves media and existing
results intact. Deploy using the protected-tree rollout gate, database snapshot
canary, backup, and exact image revision verification. There are no new secrets.

## Validation

`aiBackoffice.test.ts` exercises ownership/admin revisions, fixed batches,
idempotent delivery/reservations, pause/resume/cancel, Off/Manual modes, import
permits, target-provider drift, daily limits, provenance/history, preserved manual
fields and old results, and Sensitive changes before dispatch. UI tests exercise
review-before-confirm and local-only messaging. `mediaPipeline.integration.test.ts`
uses a real SQLite queue, asset store and FFmpeg with synthetic model responses;
it verifies cloud hold/resume without contacting a paid provider.

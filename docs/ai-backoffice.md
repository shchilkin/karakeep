# AI workspace and cloud controls

The owner's requested backoffice lives in Karakeep: `/dashboard/ai` for owned
cards and batches, `/admin/ai` for the same workspace plus administrator-only
cloud controls. It deploys with the web/worker image. It does not require another
service. These controls govern **Media AI catalog analysis**. In the deployed
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

## Bounds and follow-up

History is recorded from this release onward; the previous current state is
retained when first refreshed. The UI shows the latest 30 runs per card and latest
20 batches per owner. No archive-wide backfill, paid inference, provider changes,
GPU cutover or migration is triggered by deploying this feature.

Manual sets and embedding-based set suggestions remain a separate workstream.
This release queues existing cards and never creates sets or grants import
permits. Group imports before granting individual catalog permits if avoiding
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

# Deferred source import pilot

The `/api/v1/import` API imports a source snapshot and its full metadata into a new, private bookmark: one copied original, or native link/text content without a fake file. This bounded pilot is separate from the older import-session API. Existing capture and import-session behavior remains unchanged.

The client must first check `GET /api/v1/import/capabilities`: contract version `deferred-copy-v1`, `persistentDeferred: true` and `materialize: true`. The server requires filesystem asset storage and all policy/retention barriers from migration `0099_deferred_import_foundation`. An asset has one original, bounded by advertised `maxFileBytes`, and a raw UTF-8 JSON metadata envelope up to 4 MiB. MIME is detected independently of the filename. Supported signatures are JPEG, PNG, GIF, WebP, PDF, MP4, WebM, QuickTime, M4V and Matroska. EBML imports require a bounded header with a real DocType, not a word elsewhere in the file. Signature recognition does not decode or prove renderability; successful MKV archival does not guarantee browser playback.

### Configurable ingestion, separately bounded processing

`IMPORT_MAX_FILE_SIZE_MB` defaults to **50 MiB** and accepts integer values 1–4096. `IMPORT_IO_TIMEOUT_SEC` defaults to **20 seconds** and accepts 20–600 for each original read/copy pass. Capabilities report both settings. Writer leases cover the bounded passes; hash, declared-size, disk headroom, quota and fencing checks remain mandatory. Existing reservations/receipts can recover after the admission cap is lowered. These settings do not change ordinary `MAX_ASSET_SIZE_MB` uploads. Metadata upload stays bounded at 4 MiB/20 seconds.

Larger admission is opt-in on both server and migration client, not a deployment performed by this patch. Choose a cap from measured source sizes and disk capacity, and align client/proxy timeouts with the slowest copy/readback path. No setting bypasses upstream transport limits. Preview still reads the entire original into memory and remains capped at **50 MiB** (`maxProcessingFileBytes`). Release rejects larger originals before queuing; native cards and PDFs also remain unreleasable. No search or AI work is implicitly released by import.

### Native link/text snapshot

Require `supportedBookmarkTypes` to explicitly contain the intended type; absence means asset-only. Migration `0103_deferred_native_content` installs additional link/text update, delete and replacement barriers. Missing guards disable native admission, including writes to already reserved native operations. Legacy requests omit `content`; no defaults or transforms change their canonical payload digest.

Use the same reservation body, replacing the single attachment with `attachments: []` and adding exactly one of:

```json
{"content": {"type": "link", "url": "https://example.invalid/saved-page"}, "attachments": []}
```

```json
{"content": {"type": "text", "text": "Original note\nSecond paragraph."}, "attachments": []}
```

These are fragments, not complete requests. Source identity, `revisionKind: current`, metadata hash/size, mapping, completeness and deferred/copy policy remain required. Links must be HTTP(S), text nonblank and at most 100000 characters; the entire reservation remains bounded at 256 KiB. The URL is never fetched. The mapped title, note, tags and saved date are retained, with text source URL in its projection and all fields in the immutable payload/raw envelope. No rich-text conversion or attachment discovery is implied. Different source IDs with the same URL create distinct snapshots; identical-source retries reuse the receipt.

Upload only the reserved raw metadata, then verify/commit normally. Native status has `files: []` and receipts have `assets: []`. Completion requires independently hashing the returned metadata and reading back exact link URL/text and source mapping, plus deferred policy and held generation 0. A native card is not evidence that its referenced images, carousel, screenshot or video bytes were saved. Keep unknown completeness and unresolved descriptors explicit.

Before the first native commit, verify a consistent backup and a native-aware rollback plan. Older binaries assume an original attachment in every reservation: an image-only downgrade after native records exist is not a safe import rollback. Do not rewrite/delete native records to make old code run; recovery requires a separately approved compatible build or consistent restore plan.

## Import sequence

Use an API key with `imports:readwrite`, `assets:read` and `bookmarks:read` for import plus independent original and card-metadata verification. Read-only import inspection can use `imports:read`. The authenticated user is the owner; requests cannot choose another owner or supply a server filesystem path. Transport locators in metadata are provenance, never URLs the server fetches.

1. Send the strict reservation body defined by `packages/shared/types/deferredImport.ts` to `POST /lookup` for advisory source/content matches, then `POST /reservations` with a stable `Idempotency-Key`. All routes here use the `/api/v1/import` prefix.
2. Upload the exact reserved metadata bytes with `PUT /reservations/{id}/metadata`; for assets also upload the original stream with `PUT /reservations/{id}/files/{slot}`. Both require `X-Import-Fence` from the reservation. Preserve all unknown/not-exported source fields in the raw envelope; mapped title, note, source URL, dates and tags supplement it.
3. Call `POST /reservations/{id}/verify`, then `/commit`, with `{ "fencingToken": 1 }` using the current token. The server rereads the stage and the promoted target before publishing any card.
4. Save the commit receipt. Independently download the full original (assets only) from `/api/v1/assets/{assetId}` and the exact metadata from the receipt's relative `metadataUrl`; compare their SHA-256 checksums and actual byte counts. Read back the card mapping/content. Do not substitute a thumbnail, Range response, HTTP success code or receipt field for this readback.

`GET /reservations/{id}` recovers status and a committed receipt after a lost response. `leaseUntil` is epoch milliseconds. Re-reserving the same nonterminal payload after expiry renews the fence; a stale writer cannot publish. A concurrent I/O request returns 429 busy: inspect status, then retry the same operation later with the same approved subset. This temporary refusal does not hold the source. Exact source revision/payload retries converge on one card and receipt even with different transport keys. The same key or source revision with another payload is a 409 conflict.

Canonical payload identity is SHA-256 of UTF-8 `canonical-json-v1`: object keys recursively sorted, array order preserved, JSON primitive encoding, no Unicode normalization. Unknown, null and an empty value remain distinct. The server computes this identity itself.

## Retention and processing

Different source objects or revisions get separate cards and file occurrences, including when bytes or real source URLs match. The original filename remains in provenance. SHA evidence is also added to the exact duplicate index; review decisions can organize these copies without altering them.

Imported snapshots stay `deferred`, with their policy and content revisions unchanged. Ordinary automation and edits remain blocked. Migration `0100_import_processing_release` adds an owner-scoped, cumulative processing permit; it does not make existing or new imports automatic. Original files, raw metadata, title, note, dates and source tag associations remain retained. AI can add its own tags and description without replacing source fields.

### Explicit image processing

Check `stagePermits: true` in capabilities. JPEG, PNG, GIF and WebP imports support these cumulative stages; PDF processing is not released:

1. `preview`: reread the full original and verify its size and SHA-256, decode a bounded first frame, and save a separate WebP preview (maximum 1280 pixels per side). Store dimensions for stable cards without changing the original asset. An undecodable image fails visibly; no fake preview is published.
2. `search`: publish the retained title and source tags to the owner-scoped search index and confirm visibility.
3. `local_check`: run the local Sensitive check only. It does not call a caption model or a cloud provider.
4. `catalog`: run the enforced hybrid catalog pipeline. Local admission is required; its result selects local analysis or the configured cloud provider. Existing inference quotas and GPU admission apply. Import jobs have lower priority than interactive work. AI tags are additive; final search publication includes the result.

Read `GET /reservations/{id}/processing`, then send `POST /reservations/{id}/release` with `{"requestId":"<UUID>","stage":"preview","expectedGeneration":0}`. The same request identity is idempotent. A new release must use the current generation; stale requests and concurrent stage changes return 409. Failed releases require a new request ID and `retry: true`. The card exposes the same sequential controls. The worker persists stage progress and fenced leases, resumes after restart and never reruns completed preview work. If search publication fails after AI succeeds, retry reuses that result rather than making another paid request. Unconfirmed paid outcomes are held for inspection; ordinary retry cannot repeat a paid attempt. Free local recovery retains the lower import priority. A queued job rechecks enforced local admission when it starts, even if configuration changed after release. Each preview writer uses a unique asset ID, so an expired writer cannot overwrite a published replacement. Search is an external unversioned projection: a late obsolete response records a durable repair, and the controller republishes current data without repeating AI. Search visibility can temporarily lag during this repair; original data remains authoritative.

Without a permit, the library shows a retained-original placeholder. With a completed preview, it shows the separate saved preview. Opening an original remains an explicit authenticated read. Sensitive concealment still applies; a failed or unknown local check never becomes evidence that media is safe. Ordinary crawling, OCR, embeddings, rules, webhooks and video processing remain blocked at every release stage.

### Controller scheduling

The CPU controller drains eligible work without a fixed delay between items. It
still admits only one CPU operation at a time across controllers. An empty or
temporarily unavailable queue is polled once a second. Active AI checkpoints have
a persisted one-second polling cooldown, while terminal or missing checkpoints
can be reconciled immediately; waiting for AI does not prevent ready CPU work.
Infrastructure errors back off from one second to a maximum of 30 seconds, resetting
after recovery. Stopping wakes a sleeping controller and lets an active operation
finish without admitting the next one. Failed item stages still require an explicit
retry; faster polling does not add processing permits or repeat inference.

Adding controllers does not enable parallel preview processing, and concurrent
import I/O requests still encounter the global original-scan/import-write lease.
Pipeline overlap, bounded source prefetch and multiple preview decoders require
separate coordination of per-item ownership, quota reservations, journal writes,
stop/resume behavior and resource limits. GPU admission remains independent.

Both the private staged copy and the target copy remain retained; metadata and staged originals count toward import quota in addition to target assets. There is no automatic stage garbage collection. Capacity is 16 nonterminal operations per owner and 64 globally. Disk headroom and quota are checked before publication. Orphan maintenance and physical asset deletion respect import retention, including a target promoted before a failed database commit.

Until a retention-aware control path exists, ordinary card edits, attachment changes, list sharing, removal of retained tag associations, deletion and account cleanup cannot remove these snapshots. Shared tags used by retained snapshots cannot be renamed; unrelated tags retain normal editing behavior. Raw source metadata remains owner-only. Do not remove the custom SQL barriers during a later table rebuild; migration and guard tests must continue to prove them.

## Boundaries

Historical revisions and source/export mismatches are held; the pilot cannot authorize their resolution. Unsupported bytes are retained in staging and never materialized as a fake image or link. Multi-attachment materialization, ordered carousel projections, source cleanup, independent backup/restore proof and physical blob reuse remain separate work. A successful local synthetic test is not a production migration or backup proof. No source deletion is part of this API.

Bookmark readback uses existing Karakeep field conventions: `tags` are objects with normalized names (trimmed, leading `#` removed), and `createdAt` has whole-second SQLite precision. The exact original tags and full source timestamp remain in the immutable reservation payload and the byte-preserved source metadata envelope.

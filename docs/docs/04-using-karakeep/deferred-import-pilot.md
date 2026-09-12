# Deferred source import pilot

The `/api/v1/import` API imports one original and its full source metadata into a new, private asset bookmark. This bounded pilot is separate from the older import-session API. Existing capture and import-session behavior remains unchanged.

The client must first check `GET /api/v1/import/capabilities`: contract version `deferred-copy-v1`, `persistentDeferred: true` and `materialize: true`. The server requires filesystem asset storage and all policy/retention barriers from migration `0099_deferred_import_foundation`. It supports one original per source revision, up to 50 MiB, and a raw UTF-8 JSON metadata envelope up to 4 MiB. MIME is detected from the original signature, independently of the filename. Supported representations are JPEG, PNG, GIF, WebP and PDF; validation does not decode images or prove that every file is renderable.

## Import sequence

Use an API key with `imports:readwrite`, `assets:read` and `bookmarks:read` for import plus independent original and card-metadata verification. Read-only import inspection can use `imports:read`. The authenticated user is the owner; requests cannot choose another owner or supply a server filesystem path. Transport locators in metadata are provenance, never URLs the server fetches.

1. Send the strict reservation body defined by `packages/shared/types/deferredImport.ts` to `POST /lookup` for advisory source/content matches, then `POST /reservations` with a stable `Idempotency-Key`. All routes here use the `/api/v1/import` prefix.
2. Upload the exact reserved metadata bytes with `PUT /reservations/{id}/metadata` and the original stream with `PUT /reservations/{id}/files/{slot}`. Both require `X-Import-Fence` from the reservation. Preserve all unknown/not-exported source fields in the raw envelope; mapped title, note, source URL, dates and tags supplement it.
3. Call `POST /reservations/{id}/verify`, then `/commit`, with `{ "fencingToken": 1 }` using the current token. The server rereads the stage and the promoted target before publishing any card.
4. Save the commit receipt. Independently download the full original from `/api/v1/assets/{assetId}` and the exact metadata from the receipt's relative `metadataUrl`; compare their SHA-256 checksums and actual byte counts. Do not substitute a thumbnail, Range response, HTTP success code or receipt field for this readback.

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

Read `GET /reservations/{id}/processing`, then send `POST /reservations/{id}/release` with `{"requestId":"<UUID>","stage":"preview","expectedGeneration":0}`. The same request identity is idempotent. A new release must use the current generation; stale requests and concurrent stage changes return 409. Failed releases require a new request ID and `retry: true`. The card exposes the same sequential controls. The worker persists stage progress and fenced leases, resumes after restart and never reruns completed preview work. If search publication fails after AI succeeds, retry reuses that result rather than making another paid request. Unknown AI outcomes follow the existing catalog recovery rules instead of automatically replaying paid calls.

Without a permit, the library shows a retained-original placeholder. With a completed preview, it shows the separate saved preview. Opening an original remains an explicit authenticated read. Sensitive concealment still applies; a failed or unknown local check never becomes evidence that media is safe. Ordinary crawling, OCR, embeddings, rules, webhooks and video processing remain blocked at every release stage.

Both the private staged copy and the target copy remain retained; metadata and staged originals count toward import quota in addition to target assets. There is no automatic stage garbage collection. Capacity is 16 nonterminal operations per owner and 64 globally. Disk headroom and quota are checked before publication. Orphan maintenance and physical asset deletion respect import retention, including a target promoted before a failed database commit.

Until a retention-aware control path exists, ordinary card edits, attachment changes, list sharing, removal of retained tag associations, deletion and account cleanup cannot remove these snapshots. Shared tags used by retained snapshots cannot be renamed; unrelated tags retain normal editing behavior. Raw source metadata remains owner-only. Do not remove the custom SQL barriers during a later table rebuild; migration and guard tests must continue to prove them.

## Boundaries

Historical revisions and source/export mismatches are held; the pilot cannot authorize their resolution. Unsupported bytes are retained in staging and never materialized as a fake image or link. Multi-attachment materialization, ordered carousel projections, source cleanup, independent backup/restore proof and physical blob reuse remain separate work. A successful local synthetic test is not a production migration or backup proof. No source deletion is part of this API.

Bookmark readback uses existing Karakeep field conventions: `tags` are objects with normalized names (trimmed, leading `#` removed), and `createdAt` has whole-second SQLite precision. The exact original tags and full source timestamp remain in the immutable reservation payload and the byte-preserved source metadata envelope.

# Local check before cloud cataloging

For the opt-in ShieldGemma → Qwen / cloud routing, see [Hybrid media catalog](https://github.com/shchilkin/karakeep/blob/main/deploy/local-catalog/README.md). Hybrid mode keeps Sensitive and unknown inputs local; the defaults described below remain unchanged until it is enabled.

This branch builds on the manual Sensitive controls in PR #14. It is not enabled
by default. No production environment or saved archive is changed by the code.

## Sequence

1. Download the media to the existing asset store. AI failures never remove it.
2. Persist a job in `media_catalog_queue` and a `pending` checkpoint in the bookmark.
3. Claim `checking_local`, with one worker and no cloud quota reservation.
4. Prepare up to three JPEGs, at most 768 px and 2 MiB each. Classify them sequentially
   with the private GPU service. Store its revision, policy, categories and SHA-256
   for each exact outgoing JPEG in `mediaAi.localCheck`.
5. In `review`, finish as `local_review`: nothing is sent to a cloud provider.
6. In `enforce`, unknown results or held categories finish as `local_only`.
   Otherwise recheck input freshness, automatic-analysis opt-out, and quota;
   reserve one cloud attempt before making the existing Grok request.
7. Apply a valid title, summary and AI tags without overwriting manual fields.
   A refusal, timeout or provider error remains a terminal status with manual retry.

There is no automatic paid retry or alternate cloud provider. A lost response may
still have been billed, so the attempt remains consumed. A manual retry can reuse
a complete local result only when the input fingerprint, model/policy revision and
all prepared JPEG hashes match. A run ID prevents late results from replacing a
newer run. This prevents automatic duplicate dispatch, not provider-side exactly-once
billing across explicit manual retries.

Every minute the worker looks for stale local checkpoints (older than 11 minutes).
It rotates interrupted local runs with at most two recovery attempts. Long-pending
jobs retain the same idempotency key and do not consume that retry allowance.
A stale paid reservation becomes `timeout` and is never automatically replayed.
The recovery scan is for the current SQLite-backed deployment, not a general
distributed task scheduler.

## What the local result means

The result covers **only the outgoing images**, not the complete archive. Carousels
are evenly sampled up to three images; a single video uses 0%, 50% and 90%; mixed
collections use the existing first-frame sampling. Text-only cards stay local in
`review` and `enforce`; source title/caption/author are not classified by this image
service. Three sampled frames cannot prove that a full video contains no Sensitive
content. This is a routing aid, not a guarantee of xAI acceptance or a safety certificate.

The upload policy holds any native ShieldGemma category (`sexual`, `dangerous`,
`violence`), any unknown result, or a manually applied category hidden in Balanced
mode. All three scores below 0.5 permit the next admission checks. Native policies
do not cover all manual categories; the absence of a match is not a safety certificate. Work/Balanced/Show all display preferences
do not change the upload policy. Manual clear cannot override a detected category.

Local classifications remain separate from manual categories. Their positive
observations now drive Sensitive previews as described in the follow-up section
below. Native negatives still do not certify Work suitability.

## Settings

| Variable | Meaning |
| --- | --- |
| `MEDIA_AI_LOCAL_MODE=off` | Existing direct cloud path (default, preserves deployment behavior). |
| `MEDIA_AI_LOCAL_MODE=review` | Local test only; works with no cloud API key. |
| `MEDIA_AI_LOCAL_MODE=enforce` | Local admission before the configured cloud provider. |
| `MEDIA_AI_LOCAL_URL` | Private service URL, e.g. `http://sensitive-classifier:8091/classify`. |
| `MEDIA_AI_LOCAL_TOKEN` | Shared private service token; never commit its value. |

`MEDIA_AI_ENABLED=true` is required. Keep `MEDIA_AI_AUTO_NEW=false` during the
initial pilot and queue selected cards manually. Enabling the mode does not backfill
existing cards. The existing `MEDIA_AI_DAILY_REQUESTS` cap applies only to cloud
reservations; the owner's desired production cap is 200. Local checks do not use it.

For a supervised rollout, start with `review`, verify labeled ordinary/swimwear/
explicit and nonsexual Sensitive examples, examine misses as well as false positives,
then review the routing policy before switching to `enforce`. A successful synthetic
smoke test is not evidence of classification quality. Cloud acceptance requires its
own explicitly selected canary after local validation.

## GPU service

See [service deployment](../deploy/sensitive-classifier/README.md). It uses the pinned
`google/shieldgemma-2-4b-it` revision
`eaf60452b5fc41a911338a022e628b0c15283897`, BF16, policy `shieldgemma-native-v1`.
Scores and native categories are persisted per image; the threshold is pinned at 0.5.
Historical Nemotron results remain readable but cannot authorize new cloud requests.
CUDA is required; there is no CPU fallback. The service loads on the first request
and releases the model after 120 seconds idle. It has no archive mount and accepts
only prepared image bytes. Responses exclude raw model output and prompt text.

The GPU container has no external network access. Requests are sequential, with
bounded request/response sizes and deadlines. A hard 110-second process deadline
terminates wedged inference; container restart and bounded local job recovery handle
that failure. Other applications share the GPU, so cold latency/resource availability
can differ from the isolated smoke test.

## Grok and NSFW

[Image understanding](https://docs.x.ai/developers/model-capabilities/images/understanding)
and [Imagine generation](https://docs.x.ai/developers/model-capabilities/images/generation)
are different APIs. Imagine documents generation moderation; this does not imply
unrestricted acceptance of NSFW inputs by Grok's analysis API. The
[xAI acceptable-use policy](https://x.ai/legal/acceptable-use-policy) applies across
services and permits account sanctions for violations. A request refusal is a
different event from an account suspension. This pipeline does not circumvent
provider restrictions, and a local clean label cannot promise cloud acceptance.

## Validation

The real-queue integration test uses temporary SQLite databases, the asset store,
FFmpeg and a loopback classifier fixture. It verifies local review, held media,
cloud admission and duplicate suppression; **the Grok HTTP response is stubbed**.
The independent GPU smoke test invokes the actual HTTP service on synthetic JPEGs
with Docker networking disabled. These two checks establish plumbing, not a full
production archive-to-Grok run.

## Automatic Sensitive previews (follow-up implementation)

`MEDIA_AI_LOCAL_AUTO_NEW=true` selects explicitly **local-only** jobs at save,
attachment changes, completed crawls, and the social archive completion event.
It is independent of `MEDIA_AI_AUTO_NEW`, which may remain false. The persisted
`localOnly` intent cannot reserve or dispatch a cloud request, even in `enforce`.
Local mode must be enabled; switching it off cancels these jobs instead of
promoting them to cloud. The user's automatic-tagging opt-out is respected for
new automatic jobs. A manual local-only check/backfill is an explicit action.

A link's saved banner or screenshot can be checked when no archived original
is available. It is labeled `preview_only`; this does not check the remote page,
an unsaved original, or a full video. Completed direct image downloads and saved
images use the same queue. A changed input while queued or processing is queued
again locally; unchanged terminal inputs are deduplicated. Previous positive
observations remain visible while their replacement is being checked. Reuse for
cloud retry requires matching fingerprints and exact JPEG hashes.

Display uses the manual decision first: `null` delegates to observations, `[]`
explicitly permits the item, and nonempty arrays apply the manual categories.
Native `sexual`, `dangerous`, and `violence` detections close previews and enter
the Sensitive section without inventing finer labels. This also applies to
already stored observations, including warnings retained during retries.

Work is deliberately conservative: every item without a manual decision remains
closed, including native-negative, pending, failed, and unsupported items. A
negative three-policy sample cannot certify suitability for work, especially
swimwear/suggestive scenes or unsampled video segments. Balanced shows unchecked
items and manually marked swimwear/suggestive imagery, but closes automatic
native detections and other manual categories. Show all and the session-gated
Sensitive section preserve the explicit reveal behavior. Temporary reveal is
revoked when the manual decision or local observations change. The closed state
does not mount an image/video, so no preview file/player is loaded behind it.

Backfill is separate from enabling checks on new saves. On the application image:

```sh
# Count only: no inference, queue mutation, or cloud use.
node /app/apps/workers/dist/scripts/backfillLocalMedia.js --limit 200
# Explicitly enqueue up to one page of local-only work.
node /app/apps/workers/dist/scripts/backfillLocalMedia.js --limit 200 --apply
```

For a multi-user installation supply `--user-id`; a single owner is selected only
when exactly one exists. If `nextCursor` is returned, pass it with `--cursor` for
the next page. Limits count inspected cards, not just eligible ones. Repeating
an unchanged page does not retry terminal failures. The equivalent owner-scoped
tRPC mutation is `bookmarks.backfillLocalMedia({apply:false,limit:200})` by
default. Its apply mode only calls the local-only path. Manual decisions,
existing titles, summaries, tags and downloaded files are preserved.

This code does not enable production settings or start a backfill by deployment
alone. Model weights, native thresholds, and the cloud admission policy remain
unchanged. Fine-grained automatic labels and full-video coverage still require
separate model evaluation; manual categories remain available for those cases.

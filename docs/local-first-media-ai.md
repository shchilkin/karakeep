# Local check before cloud cataloging

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

The current upload policy allows `revealing_clothing` and `suggestive`. Any other
recognized category, any unknown result, or a manually applied category hidden in
Balanced mode holds the card locally. Work/Balanced/Show all display preferences
do not change the upload policy. Manual clear cannot override a detected category.

Local classifications are displayed as separate observations. They **do not write
manual Sensitive categories or automatically reveal/conceal cards**. Classification
accuracy on the owner's labeled examples must be reviewed before using these
observations to drive automatic display behavior.

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
`nvidia/Nemotron-3.5-Content-Safety` revision
`35645ed3543b7e7ffaed2e788699e57a5051497c`, BF16, policy `nemotron-visibility-v3`.
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

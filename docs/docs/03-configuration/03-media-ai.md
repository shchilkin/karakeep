# AI details for saved media

For the opt-in ShieldGemma → Qwen / cloud routing, see [Hybrid media catalog](https://github.com/shchilkin/karakeep/blob/main/deploy/local-catalog/README.md). Hybrid mode keeps Sensitive and unknown inputs local; the defaults described below remain unchanged until it is enabled.

This fork can generate a title, tags and a short Russian description from saved
images or video frames in one background request. Grok 4.6 is the default. This
is separate from Karakeep's text tagging, summarization and embedding settings.

## Enable

The feature is off by default. Supply these settings to **both web and workers**:

```dotenv
MEDIA_AI_ENABLED=true
MEDIA_AI_PROVIDER=xai
MEDIA_AI_MODEL=grok-4.6
MEDIA_AI_API_KEY=YOUR_XAI_KEY
MEDIA_AI_AUTO_NEW=false
MEDIA_AI_DAILY_REQUESTS=20
```

Put the real key in a private server env file (mode 0600), outside the checkout.
Do not copy an entire multi-provider credential file into the container. Only
`MEDIA_AI_API_KEY` is needed here. The client receives an enabled flag, never keys.

With automatic processing off, open a bookmark and use **Analyze saved media with
AI**. If only a saved link preview is available, the button explicitly says
**Analyze saved preview with AI**. This does not download missing originals.

Set `MEDIA_AI_AUTO_NEW=true` after verifying a first item. New uploaded image
bookmarks and links that receive the `social-media-archived` completion tag will
then be analyzed. Link attachments are not analyzed one at a time during upload.
Enabling the feature does not scan or backfill existing bookmarks. Bulk imports
do not automatically enqueue image analysis. Other formats and ordinary web
articles keep their existing behavior.
Disabling automatic tagging in the user's settings also disables automatic media analysis;
explicit manual analysis remains available.
Queued automatic jobs recheck both opt-ins before reserving an attempt and are
cancelled if automatic analysis has since been disabled.

The authenticated owner-only endpoint is
`POST /api/v1/bookmarks/:bookmarkId/analyze-media`, with JSON
`{"retry":false,"allowPreview":false}`. Add `"localOnly":true` for an explicitly
local-only check; local mode must be enabled and no cloud request is allowed. It requires bookmark write permission.
An unchanged successful input is not billed again, even with `retry:true`.
Changed inputs or a changed model can be submitted through this endpoint. A
failed input requires an explicit retry. There is no automatic provider fallback.

## Inputs and limits

- Up to three JPEGs, maximum dimension 768px, maximum 2MiB each.
- Evenly sampled carousel images; for one MP4, frames at 0%, 50% and 90%.
  Mixed collections and multiple videos use the first frame of each sampled file.
- Original asset limit 50MiB. Files exceeding it fail explicitly, without loading
  the entire file or sending its contents to a provider.
- Bounded source title, caption and author; existing tags on that bookmark.
  Notes, manual title/summary, browser cookies, credentials, storage IDs and
  full original videos are excluded.
- One worker, one provider request at a time, 120-second provider deadline,
  300-second job deadline, no automatic paid retry. FFmpeg is required and is
  already installed in the Docker runtime.
- `MEDIA_AI_DAILY_REQUESTS` caps reserved attempts across the server per UTC day.
  Reservation is durable before preparation/inference; a failure or uncertain
  timeout does not refund it. This is an attempt limit, not an invoice dollar cap.

Requests use Responses API, `store=false`, reasoning `low`, strict JSON and at
most 1200 output tokens. Keys and provider response/error bodies are not logged.
See [xAI structured outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs).

## Stored results and failures

AI metadata is stored separately in `bookmarks.mediaAi`. Manual titles take
priority over the AI title; captured page titles fall below it. Existing titles
with unknown provenance keep their priority until the owner selects **Use AI
title** in the editor. That action reuses the saved result without another model
request. Update the saving extension to distinguish captured titles from edits
on new bookmarks. See [bookmark title provenance](./04-bookmark-titles.md)
for API behavior and the read-only legacy review tool. The AI summary
is displayed only when there is no separately saved summary. Human tags are never
replaced, and a tag removed during inference or removed from an earlier AI result
is not reattached on a later analysis. New tags are marked `attachedBy: ai`.
Newly attached tags also trigger the existing tag-added rules.

Media IDs, source context, provider, model and prompt version form the input fingerprint.
The fingerprint is checked again inside the apply transaction. If the media or
caption changed while the model was working, the result becomes `stale` and is not
applied. The generated title, summary and tags are sent to the search index.

Refusal, failure, timeout, rate limit and daily quota have terminal states. A lost
worker becomes manually retryable after six minutes; its late result cannot
overwrite a newer run. These cases leave the media viewer available. A successful
JSON response is not proof of factual accuracy; the owner can edit titles/tags.

To disable processing, set `MEDIA_AI_ENABLED=false` on web and workers. Previously
generated results remain visible. Migration `0094_media_catalog` only adds a
nullable column and an attempt ledger; rolling back the application does not
require dropping data.

For OpenAI, change the provider, model and dedicated key together, for example
`MEDIA_AI_PROVIDER=openai`, `MEDIA_AI_MODEL=gpt-5.6-terra`. The endpoint is fixed by
provider; arbitrary API URLs are not accepted.

## Local-only Sensitive checks

With a configured local classifier (`MEDIA_AI_LOCAL_MODE=review` or `enforce`),
`MEDIA_AI_LOCAL_AUTO_NEW=true` enables free local checks on newly saved media,
completed crawls, and changed attachments. `MEDIA_AI_AUTO_NEW` can remain false:
local-only jobs persist their intent and never call the cloud provider. The user's
automatic-tagging opt-out still applies. Enabling this flag does not scan existing
cards. Use the bounded dry-run/backfill command described in
[the local-first pipeline](../../local-first-media-ai.md#automatic-sensitive-previews-follow-up-implementation).

Local detections close previews in Balanced and Work and appear in Sensitive.
Manual decisions override display; reset a manual decision to automatic in the
Sensitive editor. Work also closes anything not manually reviewed, since a native
negative on sampled frames does not establish work suitability. The exact mode
rules, sampling limits, retry behavior and backfill steps are in the pipeline guide.

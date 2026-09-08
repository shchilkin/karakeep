# Media previews and player lifecycle

The web library renders a still image until a card is hovered or keyboard-focused for 150 ms. Only one card preview can own playback. Opening a saved-media gallery revokes that preview and blocks other card previews until the gallery closes. Leaving the viewport, hiding the tab, or enabling reduced motion stops card playback.

Gallery videos release their source on navigation, enlargement and close: pause, remove `src`, then reset the media element. Source setup is repeatable under React StrictMode. Hidden tabs pause gallery playback without automatically resuming it.

## Virtual library

The private bookmark library mounts the visible cards plus one viewport of overscan above and below. It preserves the existing round-robin masonry column order, list/compact layouts, responsive column settings, pagination and bulk-selection data. Heights are measured with one ResizeObserver and remembered by bookmark identity and card width. Scroll updates use one passive capture listener and are coalesced into animation frames.

Changes to measured heights preserve a visible scroll anchor. Keyboard navigation mounts its target before scrolling, using an immediate scroll for virtual positions. The new-bookmark editor remains mounted to preserve drafts, as do the focused card and the last interacted-with card (including an editor rendered through a portal). Logical list positions are exposed to assistive technology. Removed bookmark measurements are discarded.

Bookmark data and React Query pages remain in memory; this bounds mounted UI/media resources, not the entire data cache. Public shared-list layouts are unchanged. Browser find-in-page sees mounted content; use the application search for the full library.

## Small hover clips

`GET /api/assets/:assetId/hover-clip` (also under `/api/v1`) generates a silent MP4 preview from an already saved MP4, WebM or Matroska asset. It uses the same authorization and API-key scope as original assets, before reading the cache. It accepts only an asset identity, never an external video URL.

- At most the first six seconds, 15 fps, H.264/yuv420p, dimensions up to 480 pixels with aspect ratio preserved, no audio/subtitles/metadata, and faststart for progressive playback.
- One ffmpeg conversion at a time with one waiting job, deduplicated by owner/asset identity. The encoder and filters use one thread. Generation and source copying have a 30-second deadline.
- Source limit 512 MiB; a private seekable temporary copy supports MP4 indexes at the end of a file. Output limit 2 MiB. Temporary files are removed on success/failure.
- `DATA_DIR/cache/hover-clips-v1` holds up to 512 MiB with seven-day expiry and private permissions. Cached results survive process restarts. Failed conversions have a bounded 60-second cooldown; overload returns 503 with Retry-After.
- Responses support standard byte ranges, including suffix ranges; malformed/unsatisfiable ranges return 416.

Cards request these clips only after hover/focus. The first request may take time to encode; the poster stays visible while waiting or on error. There is no automatic fallback to downloading the full video for hover. Gallery playback, download and AI analysis continue to use the original. Existing videos work on demand with no migration, bulk backfill or new AI calls. ffmpeg must be installed in the web runtime (the AIO Docker image already includes it).

## Authenticated thumbnails

`GET /api/assets/:assetId/thumbnail?width=640` (also available under `/api/v1`) uses the same authentication, asset authorization and API key read scope as original downloads. Supported widths are 96, 320, 640 and 1280 pixels. The result is WebP with the original aspect ratio, EXIF orientation applied and metadata stripped. Smaller images are not enlarged. Animated image thumbnails use a still frame.

Cards use responsive thumbnail sources. The gallery uses a 1280-pixel preview, smaller neighboring images and 96-pixel strip thumbnails. Enlarging a photo or downloading an asset still uses the original file. Existing clients and original asset URLs are unchanged.

Thumbnails are generated on demand, including for existing saved files. No database migration or bulk reprocessing is needed. Generation reads from the configured asset store and never fetches a URL supplied in the thumbnail request.

The recomputable cache lives under `DATA_DIR/cache/thumbnails-v1`:

- One conversion at a time per web process; duplicate requests share the result.
- At most 64 queued/in-progress unique conversions. Overload returns HTTP 503 with `Retry-After: 1`.
- Cached reads bypass the conversion queue.
- Disk cache budget 256 MiB, evicting older generated files. Seven-day expiry is checked on access, generation and restart.
- Source limit 64 MiB / 40 million pixels, plus decode and stream timeouts.
- Cache files use private permissions. Browser responses use private caching; authorization still runs on server cache hits.

A missing, unsupported or failed thumbnail shows the existing image-error state. The original remains available through enlargement/download. CPU and cache coordination are local to one web process; a multi-replica installation needs a shared conversion queue/cache policy.

## Verification

Run package tests using their own configuration:

```sh
(cd packages/api && pnpm exec vitest run)
(cd apps/web && TZ=UTC pnpm exec vitest run)
```

The browser fixture uses the actual card, gallery and playback coordinator, with synthetic media, a minimal layout, an i18n adapter and a native-image adapter for the gallery's unoptimized Next images. It does not connect to an account or modify a library.

```sh
# Requires ffmpeg and Playwright Chromium. Set PLAYWRIGHT_CHANNEL=chrome
# to use an installed Chrome with a separate temporary profile instead.
node tools/media-performance/run.mjs /tmp/karakeep-media-performance.json
```

The fixture creates 1000 cards, performs 100 hover/open/play/navigate/close cycles, scrolls through the feed, appends to 2000 cards, filters to 20, changes columns and switches to mobile window scrolling. It checks that:

- Idle cards create no video elements or video requests.
- Hover requests the small clip endpoint and gallery playback requests the original.
- Mounted card count stays bounded, keyboard targets mount, editor drafts survive scrolling, and changes above the viewport preserve the scroll anchor.
- The open gallery takes priority over card playback.
- Closing or switching away from video leaves no video elements.
- Chrome's native player creation and destruction counts match.
- DOM nodes, event listeners and JS heap do not grow beyond bounded tolerances after warm-up and forced GC.
- Normal card/gallery previews request no original image files.

A Chrome 152 run on 2026-09-08 mounted at most 36 cards during the 1000-card scroll fixture, retained the editor draft, and measured zero scroll-anchor displacement after a height change above the viewport. All 200 native players created during 100 viewing cycles were released. At cycles 10/50/100, DOM nodes were 294/294/294 and event listeners 406/406/406, with JS heap about 12–13 MiB after forced GC. No original photo requests or JavaScript errors occurred. The gallery still fetched original videos, while hover fetched only clip URLs.

These checks are lifecycle and request-budget evidence, not measurements of total browser/GPU memory, production network latency, large-video decoding, or Safari/iOS performance. API tests separately exercise real Sharp/ffmpeg conversion, orientation, H.264/duration/dimension/audio/faststart constraints, byte ranges, authorization, cache reuse across instances, queue bounds and eviction.

## Follow-up verification

Real Safari/iOS interaction and production latency still need a separate check. The current fixture covers mobile-sized window scrolling in Chrome, not Safari. The renderer retains loaded bookmark data; profiling may justify bounding query-cache pages separately for very large libraries.

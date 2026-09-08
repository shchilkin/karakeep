# Media previews and player lifecycle

The web library renders a still image until a card is hovered or keyboard-focused for 50 ms. Only one card preview can own playback. Opening a saved-media gallery revokes that preview and blocks other card previews until the gallery closes. Leaving the viewport, hiding the tab, or enabling reduced motion stops card playback.

Gallery videos release their source on navigation, enlargement and close: pause, remove `src`, then reset the media element. Source setup is repeatable under React StrictMode. Hidden tabs pause gallery playback without automatically resuming it.

## Loading feedback

Bookmark queries render inside a Suspense boundary with a responsive, image-first skeleton matching the chosen layout. The editor has its own placeholder when present; search uses the same skeleton. Real cards keep a rounded image placeholder until load, then fade in. Already cached images are detected at mount, and errors replace the placeholder with the existing error state. Skeleton animation and image transitions respect reduced motion.

The virtual feed remembers each card image's intrinsic dimensions separately from its mounted element. When a photo or video poster is revisited, its placeholder and error state reserve the same aspect ratio as the loaded image, including after a width change. Unmounting still releases the image/video elements. Each retained bookmark has at most one image-dimension record; records are removed when the bookmark leaves the result set, and a different cover URL cannot reuse stale proportions.

This prevents a previously measured portrait from shrinking to a generic 4:3 placeholder and changing the virtual layout during image reload. Dimensions are scoped to the current feed rather than a global or persistent browser cache. Saved images now include optional `width`/`height` in bookmark asset payloads. Cards reserve that aspect ratio before the first image request completes, including after a full page reload. Video cards use the dimensions of their poster asset. The frame keeps the source ratio even when a resized thumbnail rounds its pixel dimensions. Remote-only images and old files awaiting backfill still use a 4:3 estimate on their first visit, then the feed remembers their actual proportions.

Hover starts requesting the clip after 50 ms. A small indicator appears over the poster only if playback is still waiting 350 ms later; it never delays playback. Playback success, failure, cancellation and unmount clear it. A stalled initial request releases its media source after 35 seconds and keeps the poster; full playback remains available in the gallery.

## Stored dimensions and existing libraries

Migration `0096_asset_dimensions` adds nullable width/height columns to assets. Normal client uploads (including Companion photos and video posters), crawler downloads/banners/screenshots, direct-video posters and PDF screenshots populate them from image headers. Reading dimensions uses the existing Sharp version, EXIF display orientation and first-frame dimensions; it does not transcode originals. Unsupported/corrupt files and inputs over 64 MiB or 40 million pixels retain unknown dimensions. Bookmark get/list/attach responses expose these optional fields through the existing authorized queries. There is no per-card filesystem lookup on feed requests and no new access route.

Run the following **after database migration**, with the workers' normal `DATA_DIR` and asset-store environment. The built script is included in the worker image. Preview a batch before applying it:

```sh
# From /app/apps/workers inside the deployed container, or apps/workers after build:
node dist/scripts/backfillAssetDimensions.js --limit 200
node dist/scripts/backfillAssetDimensions.js --limit 200 --apply
```

The JSON summary reports scanned/measured/updated/skipped counts and `nextCursor`. If a cursor is returned, pass it as `--after '<cursor>'` to continue; repeat until it is null. Rerunning from the beginning only considers still-missing dimensions. Processing is sequential, bounded to 1–1000 entries per batch and one image buffer up to 64 MiB; it uses the configured filesystem or S3 store, never external source URLs or AI. Existing dimensions are not overwritten, and one unreadable file does not stop the batch. Skipped files retain the browser fallback. Refresh the feed after applying the backfill.

The schema change is additive; originals, notes, titles and tags are untouched. The script is an explicit maintenance step rather than automatic work in a page request or database migration.

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
(cd apps/web && TZ=UTC pnpm exec vitest run --exclude '**/.next/**')
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

A Chrome 152 run on 2026-09-08 mounted at most 36 cards during the 1000-card scroll fixture, retained the editor draft, and measured zero scroll-anchor displacement after a height change above the viewport. All 200 native players created during 100 viewing cycles were released. At cycles 10/50/100, DOM nodes were 327/327/327 and event listeners 406/406/406, with JS heap about 12–13 MiB after forced GC. No original photo requests or JavaScript errors occurred. The gallery still fetched original videos, while hover fetched only clip URLs. A separate component fixture checked light/dark/mobile skeletons, reduced motion, delayed media responses and loader removal. Web tests cover cached images, errors, fast hover playback, cancellation and the stalled-request deadline.

These checks are lifecycle and request-budget evidence, not measurements of total browser/GPU memory, production network latency, large-video decoding, or Safari/iOS performance. API tests separately exercise real Sharp/ffmpeg conversion, orientation, H.264/duration/dimension/audio/faststart constraints, byte ranges, authorization, cache reuse across instances, queue bounds and eviction.

The layout regression fixture uses actual card images, video posters, virtual masonry and Tailwind styles. First-load checks provide server dimensions and sample skeletons through image completion on desktop and mobile widths, reporting zero height change. It forces image-cache eviction between visits and delays image responses by 300 ms; cached tiny fixtures otherwise conceal the bug.

```sh
# Requires an installed Chrome and the browser-fixture dependencies.
RESULT_PATH=/tmp/karakeep-media-layout.json node tools/media-layout/run.mjs
# Optional manual visual fixture; stop with Ctrl-C.
SERVE_ONLY=1 node tools/media-layout/run.mjs
```

Before the fix, revisiting a portrait changed its height from 592 to 312 and back to 592 pixels. The regression checks both frame height and viewport position on every animation frame through reload. Repeated visits, portrait/landscape/square images and video posters, resizing, column changes, failed requests, recovery and mobile window scrolling all reported zero displacement after the fix. Mobile here is Chrome at a narrow viewport, not a Safari device test.

## Follow-up verification

Real Safari/iOS interaction and production latency still need a separate check. The current fixture covers mobile-sized window scrolling in Chrome, not Safari. The renderer retains loaded bookmark data; profiling may justify bounding query-cache pages separately for very large libraries.

# Media previews and player lifecycle

The web library renders a still image until a card is hovered or keyboard-focused for 150 ms. Only one card preview can own playback. Opening a saved-media gallery revokes that preview and blocks other card previews until the gallery closes. Leaving the viewport, hiding the tab, or enabling reduced motion stops card playback.

Gallery videos release their source on navigation, enlargement and close: pause, remove `src`, then reset the media element. Source setup is repeatable under React StrictMode. Hidden tabs pause gallery playback without automatically resuming it.

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

The fixture creates 1000 cards, performs 100 hover/open/play/navigate/close cycles, and checks that:

- Idle cards create no video elements or video requests.
- The open gallery takes priority over card playback.
- Closing or switching away from video leaves no video elements.
- Chrome's native player creation and destruction counts match.
- DOM nodes, event listeners and JS heap do not grow beyond bounded tolerances after warm-up and forced GC.
- Normal card/gallery previews request no original image files.

A Chrome 152 run on 2026-09-08 released all 204 created native players. At cycles 10/50/100, event listeners were 9190/9190/9190 and DOM nodes were 4151/4171/4171. JS heap was about 21–24 MiB after warm-up. A synthetic 3.16 MB JPEG became an 85 KB thumbnail at 640 pixels; this ratio is specific to the fixture.

These checks are lifecycle and request-budget evidence, not measurements of total browser/GPU memory, production network latency, large-video decoding, or Safari/iOS performance. API tests separately exercise real Sharp conversion, orientation, authorization, cache reuse, queue bounds and eviction.

## Next stages

The existing masonry list still retains loaded cards; virtualization remains a separate change. Hover playback still uses the saved original video. A smaller encoded hover clip can be added after these lifecycle and thumbnail changes are evaluated.

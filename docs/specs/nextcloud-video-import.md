# Deferred Nextcloud video import

Owner request: transfer the remaining Nextcloud videos after the image/PDF plan.
Preserve originals and provenance. Leave catalog/Grok processing held until sets
and set-level analysis. Do not expand the plan to held source revisions or other
unsupported files.

- Accept byte-detected MP4, WebM, QuickTime and M4V under the existing 50 MiB cap.
- Reuse atomic commit, immutable originals, fenced writes and SHA-256 readback.
- Add a video asset response subtype without opening ordinary upload automation.
- Explicit CPU preview/search release creates a separate first-frame WebP. A bad
  decoder input retains the original and records a terminal processing failure.
- Display the poster with the existing bounded hover player and internal gallery.
  Keep sensitive visibility checks and player teardown. Browser support determines
  original codec playback; hover is a small H264 derivative.
- Do not grant local/catalog video admission as part of this transfer.
- Verify fixtures for all four containers, failure retention and no AI admission.
  Production transfer is a distinct pilot and frozen resumable queue, not a fixture.

## 25 September follow-up: ingestion is not processing

The later native/large-source import change adds Matroska recognition through
bounded EBML DocType validation and makes original admission configurable, keeping
the 50 MiB default. The preview worker remains independently capped at 50 MiB;
larger receipts cannot be released. See the current [import contract](../docs/04-using-karakeep/deferred-import-pilot.md).
No conversion, mass transfer, deployment or video AI is implied by those changes.

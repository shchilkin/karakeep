# Saving direct media links

Direct file links are routed using the HTTP response Content-Type, including
URLs without a file extension. Supported images and PDFs retain the existing
file-download path. `video/mp4`, `video/webm` and `video/x-matroska` now download
the original file without browser rendering or a webpage screenshot.

The video and a JPEG of its first decodable frame are attached together. The
standard API exposes the original as `videoAssetId` and the poster as
`imageAssetId`. The web gallery uses the same assets for its existing hover
playback. Browser playback depends on container/codec support; the original
file remains downloadable. The source URL remains on the link bookmark.

Direct downloads use the crawler's validated network/proxy path, streaming
`MAX_ASSET_SIZE_MB` cap, storage quota and job timeout. They do not depend on
`CRAWLER_VIDEO_DOWNLOAD`, which controls optional video extraction from webpages.
Posters are decoded from a local file with a bounded FFmpeg process; remote
playlist fetching is disabled. A changed MIME type, failed download or corrupt
video fails the crawl without substituting a screenshot. Unattached files are
removed after failures; retries reuse a completed original/poster pair.

Once the file is attached, the existing automatic media analysis can run with
the same opt-out, model and daily limit. Failed or disabled analysis leaves the
saved original available. No new cloud request is needed merely to read a card.

This change applies to direct files. Social post URLs keep their existing
crawler and social-enricher behavior. Files served without a supported media
Content-Type, playlists, and audio-only formats are outside this routing rule.

Validation uses a synthetic MP4, real FFmpeg and an isolated SQLite database;
network and storage boundaries are test doubles. It checks original bytes,
poster generation, retry reuse, error cleanup, URL changes, API/gallery
selection and automatic-analysis controls. Live deployment and a real client
save remain separate checks.

# Source text attachments and X text-only analysis

The social-enricher can now archive X, YouTube and TikTok in the same image/video
gallery. It attaches a readable source-text copy before the completion tag. This
fork accepts `text/plain` attachments; plain text does not become a standalone
asset bookmark or a gallery slide.

An X post without images can use the existing media AI queue. Eligibility requires
an individual X/twitter.com status URL, a nonempty source description and a source
attachment named `x_<post-id>_999_<hash>.txt`. A mismatched source copy or an
ordinary link preview does not qualify. When a source copy exists, the text takes
precedence over a generic crawler banner, including for manual retries.

The model receives the bounded source text as untrusted data, with a text-specific
instruction and no invented image input. The same provider, opt-ins, 200-request
configured daily budget, terminal failures and title-ownership rules apply. There
is no new provider configuration, automatic backfill or database migration.

Deploy this fork before the sidecar's social-platforms version, since the latter
uploads `text/plain` copies for all new sources. Existing Instagram image/video
behavior is covered by the unchanged media preparation tests.

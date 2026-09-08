# Saving through standard Karakeep clients

The fork accepts the ordinary bookmark create/update APIs. A client only needs
to save a supported post URL. Account connection remains a separate Companion
operation; saving does not transfer browser cookies.

## API compatibility

Authenticated bookmark responses expose the selected AI title in `title` when
there is no stored override or its `titleSource` is `captured`. `originalTitle`
contains the stored override (including null). Manual and legacy `unknown`
titles remain protected. A legacy extension cannot distinguish a captured page
title from a human title; the owner can select "Use AI title" in the web editor.
There is no bulk rewrite or new AI request when a client reads a bookmark.

For link cards, `content.imageAssetId` is the first stored image or the first
video's matching `.poster.jpg`. If the first video has no poster, the crawler
cover is retained; MP4 bytes and another slide never become its image cover.
The server and web gallery use the same ordering/selection function. Originals,
crawler assets, source metadata and public sharing serialization are retained.
The new projection does not publish private attachments as signed public covers.

An old edit form echoing the current AI title does not turn it into a manual
override. A different title is a manual edit; `titleSource: manual` explicitly
pins even an identical title. Source and user text are kept in the database.

## Retrying an unfinished archive

An explicit create request for an existing URL still restores the card and bumps
its date. It also emits `operation: edited, reason: resaved`. Ordinary edits,
asset attachments and analysis updates have no such reason. Import/RSS exempt
resaves retain their existing behavior. Webhook IDs remain the delivery dedup key.

The social enricher must accept this reason and its existing webhook must
subscribe to **created and edited**. An older enricher safely ignores it. A
created-only subscription continues new downloads but cannot retry on resave.
Completed archives are skipped by the enricher, so resave does not rerun paid
analysis or re-upload a completed archive. No automatic replay of the old library
or endless retry timer is introduced. Resave uses Karakeep's existing URL dedup
rules; two different share tokens can still produce different cards.

## Deployment verification

Deploy the matching enricher and this fork under separate deployment approval,
then update only that enricher webhook's events, preserving its URL and token.
Save one new post with a standard client, verify originals/poster and standard
API fields. Retry one failed post by saving its existing URL after reconnecting.
Verify one added queue job, completion and no second AI request for an already
analysed, unchanged archive. An ordinary note/tag edit must not add a download.

Tests cover API contracts and synthetic worker delivery/redirects. Actual
installed iOS/Chrome/Safari behavior and new short TikTok links still require
this deployment canary. No browser session or paid model call is part of tests.

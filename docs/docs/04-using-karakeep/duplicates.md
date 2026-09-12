# Review duplicate originals

Open **Duplicates** in the dashboard, then select **Find duplicates**. Karakeep reads the owner's saved original attachments and groups files with matching SHA-256 checksums and sizes. Renamed files can match; files with the same name but different bytes do not. Generated banners, screenshots and known video posters are excluded.

The page shows index coverage and files that could not be verified. Browsing it does not start a scan. Indexing reads one file at a time, with a 512 MiB limit and a 20-second deadline per file. Keep the page open while scanning; **Stop after this file** stops the loop. Reopening and selecting **Find duplicates** resumes by skipping indexed files. **Recheck all originals** revisits previously indexed files and errors. Newly saved files need another scan. Indexing uses the configured asset store and does not invoke AI or change media.

Open a group to compare the original files, filenames, dimensions, save dates, source links, lists, tags, notes and attachment counts. Matching-original counts distinguish a shared attachment from the rest of a carousel. The page expands up to 50 cards per group and labels larger groups. Work mode keeps sensitive media hidden until revealed, including its download and original-size controls.

**Keep all cards**, **Review later** and **Prefer this card** save review decisions. **Undo decision** reopens the group. These decisions only organize review: they preserve every card, note and file and do not reclaim disk space. A changed set of matching originals reopens review. A stale browser tab must refresh before overwriting another decision.

This first version detects exact file bytes. It does not detect resized or visually similar pictures, merge cards, trash files, reuse physical blobs, or import external source manifests. Checksum evidence describes the verification time shown on the page; out-of-band storage changes require a recheck.

## API and integration

The `duplicates` tRPC router and `/api/v1/duplicates` REST routes use the same owner-scoped model. Read endpoints require `bookmarks:read`; decisions require `bookmarks:readwrite`. Scanning requires a signed-in web session and rejects API keys. Read-only mode rejects both mutations.

| Method | Route | Result |
| --- | --- | --- |
| GET | `/duplicates/status` | Coverage, errors, file-size cap, `physicalReuse: false` |
| GET | `/duplicates?view=pending&limit=20&cursor=…` | Group summaries and `nextCursor` |
| GET | `/duplicates/{groupId}` | Evidence and decision versions, members, cards and their context |
| POST | `/duplicates/scan-next` | One hash step; body `{ "afterId": null, "recheck": false }` |
| POST | `/duplicates/decisions` | Save or undo a decision using optimistic concurrency tokens |

For scans, pass each `nextCursor` as `afterId` until `done` is true. A 409 means another file reader holds the global lease; the reader lease expires after 60 seconds if its process dies. For group lists, follow `nextCursor` even on empty pages: decision filtering follows bounded candidate pagination.

A decision request contains `groupId`, `evidenceVersion`, `expectedDecisionVersion`, `decision` (`keep_both`, `defer`, `prefer_primary`, or null), and optional `primaryBookmarkId`. A 409 requires refreshing the comparison. Undo advances the decision version, preventing stale writes after an undo.

Migration `0098_duplicate_review` adds only the hash index, groups, decisions and reader lease. It neither scans storage nor changes existing media ownership. Deploy the normal application migration before opening the new page. Source-ledger import and retention require separate contracts; this API deliberately makes no merge, deletion or physical reuse promise.

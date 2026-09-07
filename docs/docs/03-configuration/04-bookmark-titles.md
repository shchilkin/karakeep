# Bookmark titles

Captured page titles no longer override saved AI titles. Titles explicitly
edited by the owner still take priority. `title` retains the stored value;
`titleSource` distinguishes `captured`, `manual`, and `unknown`.

- Display and search use manual/unknown title → AI title → page title or filename.
  A captured title falls below the AI title but remains available when there is
  no AI result.
- Migration 0095 marks existing rows `unknown` without changing any title or AI
  result. Titles from clients that omit provenance are also `unknown`.
- The updated extension sends `captured` for tab titles, and `manual` when the
  user changes the title in its save form (including context-menu saves).
- A duplicate POST refreshes a captured title only if it is still captured or
  empty at write time. Unmarked duplicate POSTs leave titles unchanged. An
  explicit `manual` POST is an intentional edit. This changes older clients'
  duplicate-save behavior: use PATCH for title edits.
- PATCH with `title` defaults to `manual`. PATCH without `title` leaves the
  value and provenance alone. Clearing the title restores automatic naming.
  The web editor sends a title only when its title field has changed.
- **Use AI title** in the web editor submits only `titleSource: "captured"`.
  It keeps the stored name, triggers the normal search reindex, and makes no AI
  request. Unsaved form changes disable this action so they are not discarded.

## Existing library review

Run on the server that stores the database:

```sh
python3 tools/review-legacy-titles.py /path/to/db.db
```

The tool opens SQLite read-only, supports both pre- and post-migration schemas,
and reports unknown titles that hide an existing AI title. The report includes
private titles: keep it on the server or in a private review artifact, never in
a public commit or PR. Generic Instagram titles are review hints only; the tool
does not change rows or infer that a title was never edited.

After reviewing a candidate, the owner can select **Use AI title** in the editor,
or PATCH `/api/v1/bookmarks/:id` with `{"titleSource":"captured"}`. This reuses the
existing result. Do not re-run analysis to rename a bookmark.

Deploy the server migration before loading the updated extension. Existing
extensions remain usable and cannot overwrite titles on duplicate saves, but
new titles they submit remain `unknown`; update the saving extension to obtain
automatic AI title selection for newly captured pages. Cookie-only companion
extensions do not submit bookmark titles and do not need this change.

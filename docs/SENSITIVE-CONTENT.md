# Sensitive content display

This first version uses **manual categories only**. There is no automatic classifier, archive backfill, or external moderation request. Unmarked items are visible; absence of a mark does not certify an item as safe.

## Display modes

| Mode | Concealed categories |
| --- | --- |
| Work | Every marked category, including revealing clothing and suggestive imagery |
| Balanced (default) | Nudity, explicit sexual content, violence, gore, self-harm, drugs, hate/extremism, disturbing, other |
| Show all | None, after the session confirmation |

The header control saves the mode in the existing browser settings cookie. A single item can be revealed explicitly until the page reloads or the mode changes. Changing its categories invalidates that reveal. Concealed cards and previews do not mount images or players; image cards keep the current cover's stored or learned proportions.

The Sensitive section lists all marked bookmarks, including archived ones, with normal server pagination. Its previews are open after a warning acknowledged once per tab session (`sessionStorage`). Returning to the feed restores the selected mode. A persisted Show all preference requires confirmation again in a new tab session. Browser session restoration can retain sessionStorage.

These controls apply to this web client. They are display preferences, not asset access control or a replacement for authentication. Original mobile/extension clients can continue saving links; they do not implement these display modes.

## Manual categories and API

Use **Sensitive categories** in the card's actions menu or the eye-off button in the expanded preview. The switch clears or enables the mark; multiple categories can be selected. Marking a bookmark requires ownership.

`PATCH /api/v1/bookmarks/:id` accepts `sensitiveCategories`, an array of unique values:

`revealing_clothing`, `suggestive`, `nudity`, `explicit_sexual`, `violence`, `gore`, `self_harm`, `drugs`, `hate_extremism`, `disturbing`, `other`.

`GET /api/v1/bookmarks?sensitive=true` lists marked items. `sensitive=false` lists unmarked/cleared items; omitting the parameter preserves the original list behavior. tRPC uses the same fields.

Migration `0097_sensitive_categories` adds a nullable JSON text column to bookmarks. Existing rows stay null (unmarked). An explicit empty array is a manual clear. Old clients that omit the field preserve it on updates. Future automatic classification must use separate provenance/status fields and respect these manual choices; it must not overwrite this column.

## Validation

- Shared policy tests cover all categories, mixed categories, empty values and input validation.
- tRPC tests cover persistence, ownership, pagination before filtering, and older-client compatibility.
- React tests cover safe initial rendering, new-session confirmation, cancelling, revealing and unmounting media, section exit, and preference save failures.
- Real Chrome verification on an isolated database with synthetic media covers both desktop and mobile, server persistence after reload, route transitions, no hidden image requests and no console exceptions. The local fixture does not contain private archive media.

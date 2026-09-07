"""Read-only review of stored titles that hide an existing AI title.

Run on the server hosting db.db. No model requests, updates or asset reads.
The output contains private library metadata; keep it out of public Git/PRs.
"""

import argparse
import json
import pathlib
import re
import sqlite3


def review(db):
    columns = {row[1] for row in db.execute("PRAGMA table_info(bookmarks)")}
    source = "titleSource" if "titleSource" in columns else "'unknown'"
    candidates = []
    for bookmark_id, title, title_source, raw in db.execute(
        f"SELECT id, title, {source}, mediaAi FROM bookmarks WHERE title IS NOT NULL"
    ):
        if title_source != "unknown" or not title.strip():
            continue
        try:
            state = json.loads(raw or "null") or {}
            ai_title = (state.get("result") or {}).get("title")
        except (ValueError, AttributeError):
            continue
        if not isinstance(ai_title, str) or not ai_title.strip() or title == ai_title:
            continue
        # A review hint only, never sufficient evidence for an automatic change.
        boilerplate = bool(re.fullmatch(
            r"(?:\(\d+\)\s*)?(?:(?:Stories|Post isn[’']t available)\s*[•·]\s*)?Instagram",
            title.strip(), re.IGNORECASE,
        ))
        candidates.append({
            "bookmarkId": bookmark_id,
            "currentTitle": title,
            "aiTitle": ai_title,
            "reviewHint": "generic_page_title" if boilerplate else "ambiguous",
        })
    return {"mode": "review_only", "count": len(candidates), "candidates": candidates}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=pathlib.Path)
    args = parser.parse_args()
    with sqlite3.connect(args.database.resolve().as_uri() + "?mode=ro", uri=True) as db:
        db.execute("PRAGMA query_only=ON")
        print(json.dumps(review(db), ensure_ascii=False, indent=2))

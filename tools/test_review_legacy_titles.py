import importlib.util
import json
import pathlib
import sqlite3
import unittest

spec = importlib.util.spec_from_file_location(
    "review_titles", pathlib.Path(__file__).with_name("review-legacy-titles.py")
)
review_titles = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review_titles)


class ReviewLegacyTitlesTest(unittest.TestCase):
    def test_old_schema_review_does_not_change_rows(self):
        db = sqlite3.connect(":memory:")
        db.execute("CREATE TABLE bookmarks(id TEXT, title TEXT, mediaAi TEXT)")
        ai = json.dumps({"result": {"title": "Studio portrait"}})
        db.executemany("INSERT INTO bookmarks VALUES(?,?,?)", [
            ("generic", "Stories • Instagram", ai),
            ("ambiguous", "My favourite portrait", ai),
            ("clear", "", ai),
            ("missing", "Instagram", None),
            ("invalid", "Instagram", "bad json"),
        ])
        before = db.execute("SELECT * FROM bookmarks").fetchall()
        db.execute("PRAGMA query_only=ON")
        report = review_titles.review(db)
        self.assertEqual(report["count"], 2)
        self.assertEqual([c["reviewHint"] for c in report["candidates"]], ["generic_page_title", "ambiguous"])
        self.assertEqual(db.execute("SELECT * FROM bookmarks").fetchall(), before)
        db.close()

    def test_new_schema_only_reviews_unknown_titles(self):
        db = sqlite3.connect(":memory:")
        db.execute("CREATE TABLE bookmarks(id TEXT, title TEXT, titleSource TEXT, mediaAi TEXT)")
        for source in ("manual", "captured", "unknown"):
            db.execute("INSERT INTO bookmarks VALUES(?,?,?,?)", (source, "Instagram", source, json.dumps({"result": {"title": "Portrait"}})))
        report = review_titles.review(db)
        self.assertEqual([c["bookmarkId"] for c in report["candidates"]], ["unknown"])
        db.close()


if __name__ == "__main__":
    unittest.main()

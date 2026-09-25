-- Native source projections are as immutable as imported originals.
-- This migration starts no processing and changes no existing snapshots.
CREATE TRIGGER deferred_link_update BEFORE UPDATE ON bookmarkLinks
WHEN EXISTS (SELECT 1 FROM bookmarks WHERE id IN (OLD.id, NEW.id) AND processingPolicy = 'deferred')
BEGIN SELECT RAISE(ABORT, 'Deferred imported link is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER deferred_link_delete BEFORE DELETE ON bookmarkLinks
WHEN EXISTS (SELECT 1 FROM bookmarks WHERE id = OLD.id AND processingPolicy = 'deferred')
BEGIN SELECT RAISE(ABORT, 'Deferred imported link is retained'); END;
--> statement-breakpoint
CREATE TRIGGER deferred_link_insert BEFORE INSERT ON bookmarkLinks
WHEN EXISTS (SELECT 1 FROM importSourceRevisions WHERE bookmarkId = NEW.id AND state = 'committed')
BEGIN SELECT RAISE(ABORT, 'Committed import projection cannot be replaced'); END;
--> statement-breakpoint
CREATE TRIGGER deferred_text_update BEFORE UPDATE ON bookmarkTexts
WHEN EXISTS (SELECT 1 FROM bookmarks WHERE id IN (OLD.id, NEW.id) AND processingPolicy = 'deferred')
BEGIN SELECT RAISE(ABORT, 'Deferred imported text is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER deferred_text_delete BEFORE DELETE ON bookmarkTexts
WHEN EXISTS (SELECT 1 FROM bookmarks WHERE id = OLD.id AND processingPolicy = 'deferred')
BEGIN SELECT RAISE(ABORT, 'Deferred imported text is retained'); END;
--> statement-breakpoint
CREATE TRIGGER deferred_text_insert BEFORE INSERT ON bookmarkTexts
WHEN EXISTS (SELECT 1 FROM importSourceRevisions WHERE bookmarkId = NEW.id AND state = 'committed')
BEGIN SELECT RAISE(ABORT, 'Committed import projection cannot be replaced'); END;

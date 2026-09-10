import { sql } from "drizzle-orm";
import { bookmarks } from "@karakeep/db/schema";

/** Same precedence as shared/sensitiveVisibility: a manual clear wins. Filter
 * before pagination, including observations retained during a retry. Unknown
 * cards belong in the normal feed, not in a falsely labeled Sensitive group. */
export function sensitiveBookmarkCondition() {
  return sql`CASE WHEN ${bookmarks.sensitiveCategories} IS NOT NULL
    THEN coalesce(json_array_length(${bookmarks.sensitiveCategories}), 0) > 0
    ELSE EXISTS (
      SELECT 1 FROM json_each(${bookmarks.mediaAi}, '$.localCheck.frames') AS frame
      WHERE coalesce(json_array_length(frame.value, '$.categories'), 0) > 0
    ) END`;
}

import { sql } from "drizzle-orm";
import { bookmarks } from "@karakeep/db/schema";

/** Same precedence as shared/sensitiveVisibility: a manual clear wins. Filter
 * before pagination, including observations retained during a retry. Unknown
 * cards belong in the normal feed, not in a falsely labeled Sensitive group. */
export function sensitiveBookmarkCondition() {
  return sql`(EXISTS (SELECT 1 FROM imageSetMembers m JOIN bookmarks original ON original.id = m.bookmarkId WHERE m.setId = ${bookmarks.id} AND (CASE WHEN original.sensitiveCategories IS NOT NULL THEN coalesce(json_array_length(original.sensitiveCategories), 0) > 0 ELSE EXISTS (SELECT 1 FROM json_each(original.mediaAi, '$.localCheck.frames') AS frame WHERE coalesce(json_array_length(frame.value, '$.categories'), 0) > 0) END)) OR CASE WHEN ${bookmarks.sensitiveCategories} IS NOT NULL
    THEN coalesce(json_array_length(${bookmarks.sensitiveCategories}), 0) > 0
    ELSE EXISTS (
      SELECT 1 FROM json_each(${bookmarks.mediaAi}, '$.localCheck.frames') AS frame
      WHERE coalesce(json_array_length(frame.value, '$.categories'), 0) > 0
    ) END)`;
}

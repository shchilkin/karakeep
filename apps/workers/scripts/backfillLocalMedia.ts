import "dotenv/config";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { db } from "@karakeep/db";
import { users } from "@karakeep/db/schema";
import { getQueueClient } from "@karakeep/shared/queueing";
import { backfillLocalMedia } from "@karakeep/trpc/models/localMediaBackfill";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    limit: { type: "string", default: "200" },
    "user-id": { type: "string" },
    cursor: { type: "string" },
  },
});
const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1 || limit > 200)
  throw new Error("Limit must be between 1 and 200");
try {
  const owners = db
    .select({ id: users.id })
    .from(users)
    .where(values["user-id"] ? eq(users.id, values["user-id"]) : undefined)
    .limit(2)
    .all();
  if (owners.length !== 1)
    throw new Error("Specify --user-id for exactly one existing owner");
  const summary = await backfillLocalMedia(db, owners[0].id, {
    apply: values.apply,
    limit,
    cursor: values.cursor,
  });
  console.log(
    JSON.stringify({
      mode: values.apply ? "apply-local-only" : "dry-run",
      ...summary,
    }),
  );
  if (summary.failed) process.exitCode = 1;
  if (summary.queued) await (await getQueueClient()).shutdown?.();
} finally {
  db.$client.close();
}

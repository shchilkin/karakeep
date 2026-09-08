import "dotenv/config";
import { parseArgs } from "node:util";
import { db } from "@karakeep/db";
import { backfillAssetDimensions } from "../lib/backfillAssetDimensions";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    limit: { type: "string", default: "200" },
    after: { type: "string", default: "" },
  },
});
console.log(
  JSON.stringify(
    await backfillAssetDimensions(db, {
      apply: values.apply,
      limit: Number(values.limit),
      after: values.after,
    }),
  ),
);

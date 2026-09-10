import { expect, it } from "vitest";
import {
  sensitiveCategories,
  shouldConcealSensitive,
  zSensitiveCategories,
} from "./sensitiveContent";

it("keeps unmarked and manually cleared items visible", () => {
  for (const mode of ["work", "balanced", "all"] as const) {
    expect(shouldConcealSensitive(null, mode)).toBe(false);
    expect(shouldConcealSensitive([], mode)).toBe(false);
  }
});
it("distinguishes work, balanced, and show all across every category", () => {
  for (const category of sensitiveCategories) {
    expect(shouldConcealSensitive([category], "work")).toBe(true);
    expect(shouldConcealSensitive([category], "balanced")).toBe(
      !["revealing_clothing", "suggestive"].includes(category),
    );
    expect(shouldConcealSensitive([category], "all")).toBe(false);
  }
  expect(
    shouldConcealSensitive(
      ["revealing_clothing", "explicit_sexual"],
      "balanced",
    ),
  ).toBe(true);
});
it("rejects unknown and duplicate category input", () => {
  expect(zSensitiveCategories.safeParse(["not-a-category"]).success).toBe(
    false,
  );
  expect(zSensitiveCategories.safeParse(["nudity", "nudity"]).success).toBe(
    false,
  );
});

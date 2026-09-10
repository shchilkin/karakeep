import { expect, test } from "vitest";
import { zMediaCatalogState } from "./mediaCatalog";
import {
  LOCAL_CHECK_MODEL,
  LOCAL_CHECK_POLICY,
  LOCAL_CHECK_REVISION,
} from "./mediaLocalCheck";
import {
  concealSensitiveBookmark,
  sensitiveAssessment,
  sensitiveRevealKey,
} from "./sensitiveVisibility";

function observation(categories: string[] = [], status = "complete") {
  return zMediaCatalogState.parse({
    runId: "r1",
    fingerprint: "f1",
    model: "catalog",
    status: "local_review",
    updatedAt: new Date().toISOString(),
    allowPreview: true,
    localCheck: {
      scope: "outgoing_images_only",
      frames: [
        {
          model: LOCAL_CHECK_MODEL,
          revision: LOCAL_CHECK_REVISION,
          policy: LOCAL_CHECK_POLICY,
          precision: "bf16",
          status,
          categories,
          sha256: "a".repeat(64),
          scores:
            status === "unknown"
              ? null
              : {
                  sexual: categories.includes("sexual") ? 0.9 : 0.01,
                  violence: categories.includes("violence") ? 0.9 : 0.01,
                  dangerous: categories.includes("dangerous") ? 0.9 : 0.01,
                },
        },
      ],
    },
  });
}

test("Work hides unchecked, failed, and native-negative cards; Balanced does not mislabel unknown", () => {
  for (const mediaAi of [
    null,
    observation(),
    observation([], "unknown"),
    { ...observation(), status: "local_failed" as const },
  ]) {
    const card = { id: "card", mediaAi };
    expect(concealSensitiveBookmark(card, "work")).toBe(true);
    expect(concealSensitiveBookmark(card, "balanced")).toBe(false);
    expect(sensitiveAssessment(card).sensitive).toBe(false);
    expect(concealSensitiveBookmark(card, "all")).toBe(false);
  }
});

test.each(["sexual", "dangerous", "violence"])(
  "native %s conceals without fabricating a finer category",
  (category) => {
    const card = { id: "card", mediaAi: observation([category]) };
    expect(concealSensitiveBookmark(card, "balanced")).toBe(true);
    expect(concealSensitiveBookmark(card, "work")).toBe(true);
    expect(sensitiveAssessment(card).labels).toEqual([
      `media_ai.native_categories.${category}`,
    ]);
    expect(concealSensitiveBookmark(card, "all")).toBe(false);
  },
);

test("manual decision wins and null restores automatic detection", () => {
  const card = { id: "card", mediaAi: observation(["sexual"]) };
  expect(
    concealSensitiveBookmark({ ...card, sensitiveCategories: [] }, "work"),
  ).toBe(false);
  expect(
    sensitiveAssessment({ ...card, sensitiveCategories: [] }).sensitive,
  ).toBe(false);
  expect(
    concealSensitiveBookmark(
      { ...card, sensitiveCategories: ["revealing_clothing"] },
      "balanced",
    ),
  ).toBe(false);
  expect(
    concealSensitiveBookmark(
      { ...card, sensitiveCategories: ["revealing_clothing"] },
      "work",
    ),
  ).toBe(true);
  expect(
    concealSensitiveBookmark(
      { ...card, sensitiveCategories: null },
      "balanced",
    ),
  ).toBe(true);
});

test("retained positive observations keep previews closed during retries and temporary reveals expire on new evidence", () => {
  const card = { id: "card", mediaAi: observation(["sexual"]) };
  expect(
    concealSensitiveBookmark(
      { ...card, mediaAi: { ...card.mediaAi, status: "pending" } },
      "balanced",
    ),
  ).toBe(true);
  expect(sensitiveRevealKey(card)).not.toBe(
    sensitiveRevealKey({ ...card, mediaAi: observation(["violence"]) }),
  );
  expect(sensitiveRevealKey({ ...card, sensitiveCategories: [] })).not.toBe(
    sensitiveRevealKey({ ...card, sensitiveCategories: null }),
  );
});

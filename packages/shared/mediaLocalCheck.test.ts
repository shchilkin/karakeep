import { expect, test } from "vitest";
import {
  LOCAL_CHECK_MODEL,
  LOCAL_CHECK_POLICY,
  LOCAL_CHECK_REVISION,
  zLocalFrameResult,
  zLocalCheckResult,
  zCurrentLocalCheckResult,
  holdLocalMedia,
  localCheckCategoryKeys,
} from "./mediaLocalCheck";

const frame = {
  model: LOCAL_CHECK_MODEL,
  revision: LOCAL_CHECK_REVISION,
  policy: LOCAL_CHECK_POLICY,
  precision: "bf16",
  status: "complete",
  categories: [],
  scores: { dangerous: 0.1, sexual: 0.1, violence: 0.1 },
};
const check = (value: unknown) =>
  zLocalCheckResult.parse({
    scope: "outgoing_images_only",
    frames: [{ ...(value as object), sha256: "a".repeat(64) }],
  });

test.each(["dangerous", "sexual", "violence"])(
  "native %s at the threshold holds cloud dispatch without inventing finer categories",
  (category) => {
    const result = check({
      ...frame,
      categories: [category],
      scores: { ...frame.scores, [category]: 0.5 },
    });
    expect(holdLocalMedia(result)).toBe(true);
    expect(localCheckCategoryKeys(result)).toEqual([
      `media_ai.native_categories.${category}`,
    ]);
  },
);

test("all scores below threshold are eligible; unknown stays local", () => {
  expect(holdLocalMedia(check(frame))).toBe(false);
  expect(
    holdLocalMedia(check({ ...frame, status: "unknown", scores: null })),
  ).toBe(true);
});

test.each([
  { ...frame, scores: null },
  { ...frame, scores: { sexual: 0.1 } },
  { ...frame, scores: { ...frame.scores, sexual: Infinity } },
  { ...frame, scores: { ...frame.scores, sexual: 0.9 } },
  { ...frame, categories: ["sexual"] },
  {
    ...frame,
    categories: ["sexual", "sexual"],
    scores: { ...frame.scores, sexual: 0.9 },
  },
  { ...frame, status: "unknown" },
  { ...frame, rawOutput: "PRIVATE_CANARY" },
])("rejects incomplete and contradictory observations", (value) => {
  expect(zLocalFrameResult.safeParse(value).success).toBe(false);
});

test("historical Nemotron observations are readable, but not current admission evidence", () => {
  const result = check({
    model: "nvidia/Nemotron-3.5-Content-Safety",
    revision: "35645ed3543b7e7ffaed2e788699e57a5051497c",
    policy: "nemotron-visibility-v3",
    precision: "bf16",
    status: "complete",
    categories: ["revealing_clothing"],
  });
  expect(localCheckCategoryKeys(result)).toEqual([
    "sensitive.categories.revealing_clothing",
  ]);
  expect(zCurrentLocalCheckResult.safeParse(result).success).toBe(false);
});

import { expect, it } from "vitest";
import { positionMasonry, visibleMasonry } from "./virtualMasonry";

const ids = Array.from({ length: 25 }, (_, i) => String(i));
const height = (id: string) => (Number(id) % 5 < 2 ? 560 : 180);

it("balances mixed heights instead of leaving several empty column tails", () => {
  const layout = positionMasonry(ids, 5, height);
  const ends = layout.lanes.map((lane) => {
    const last = lane.at(-1)!;
    return last.top + last.height;
  });
  expect(Math.max(...ends) - Math.min(...ends)).toBeLessThanOrEqual(560);
  expect(layout.positions.map((item) => item.id)).toEqual(ids);
});

it("keeps existing columns on prepend, append, deletion and late measurements", () => {
  const before = positionMasonry(ids, 5, height);
  const updated = ["new", ...ids.filter((id) => id !== "4"), "older"];
  const after = positionMasonry(updated, 5, (id) => height(id) + 30, {
    previous: before,
  });
  for (const id of updated.filter((id) => before.byId.has(id))) {
    expect(after.byId.get(id)!.column).toBe(before.byId.get(id)!.column);
  }
  expect(after.byId.has("4")).toBe(false);
  expect(after.byId.get("new")!.top).toBe(0);
  for (const lane of after.lanes) {
    for (let i = 1; i < lane.length; i++)
      expect(lane[i].top).toBe(lane[i - 1].top + lane[i - 1].height);
  }
});

it("places new cards in the shortest projected column without moving old cards", () => {
  const before = positionMasonry(["tall", "short"], 2, (id) =>
    id === "tall" ? 600 : 100,
  );
  const after = positionMasonry(["new", "tall", "short"], 2, () => 100, {
    previous: before,
  });
  // Updated heights count, not the previous layout's stale measurements.
  expect(after.byId.get("new")!.column).toBe(0);
  const tall = positionMasonry(
    ["new", "tall", "short"],
    2,
    (id) => (id === "tall" ? 600 : 100),
    { previous: before },
  );
  expect(tall.byId.get("new")!.column).toBe(1);
});

it("rebuilds for a new sort or column count and keeps grid row order", () => {
  const previous = positionMasonry(ids, 5, height);
  const sorted = [...ids].reverse();
  expect(positionMasonry(sorted, 5, height, { previous }).positions).toEqual(
    positionMasonry(sorted, 5, height).positions,
  );
  expect(positionMasonry(ids, 2, height, { previous }).positions).toEqual(
    positionMasonry(ids, 2, height).positions,
  );
  expect(
    positionMasonry(ids, 5, height, { balanced: false }).positions.map(
      (item) => item.column,
    ),
  ).toEqual(ids.map((_, index) => index % 5));
});

it("finds exactly the visible items in unequal columns", () => {
  const layout = positionMasonry(ids, 5, height);
  expect(visibleMasonry(layout.lanes, 700, 1100)).toEqual(
    layout.positions.filter(
      (item) => item.top <= 1100 && item.top + item.height >= 700,
    ),
  );
});

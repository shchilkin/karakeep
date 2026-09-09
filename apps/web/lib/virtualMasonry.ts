export interface MasonryPosition {
  id: string;
  index: number;
  column: number;
  top: number;
  height: number;
  previousInColumn?: number;
  nextInColumn?: number;
}

export interface MasonryLayout {
  positions: MasonryPosition[];
  lanes: MasonryPosition[][];
  byId: Map<string, MasonryPosition>;
  height: number;
}

/** Balance new cards while keeping existing IDs in their columns. */
export function positionMasonry(
  ids: readonly string[],
  columns: number,
  height: (id: string, index: number) => number,
  {
    previous,
    balanced = true,
  }: { previous?: MasonryLayout; balanced?: boolean } = {},
): MasonryLayout {
  // A deliberate sort change or responsive column count starts a new layout.
  let reuse = balanced && previous?.lanes.length === columns;
  let lastIndex = -1;
  if (reuse) {
    for (const id of ids) {
      const item = previous!.byId.get(id);
      if (!item) continue;
      if (item.index < lastIndex) {
        reuse = false;
        break;
      }
      lastIndex = item.index;
    }
  }
  const heights = ids.map((id, index) => {
    const value = height(id, index);
    return Number.isFinite(value) ? Math.max(1, value) : 1;
  });
  const lanes: MasonryPosition[][] = Array.from({ length: columns }, () => []);
  const ends = Array<number>(columns).fill(0);
  const remaining = Array<number>(columns).fill(0);
  if (reuse) {
    ids.forEach((id, index) => {
      const item = previous!.byId.get(id);
      if (item) remaining[item.column] += heights[index];
    });
  }
  const positions: MasonryPosition[] = ids.map((id, index) => {
    const existing = reuse ? previous!.byId.get(id) : undefined;
    let column = existing?.column ?? index % columns;
    if (balanced && !existing) {
      column = 0;
      for (let lane = 1; lane < columns; lane++) {
        // Include later existing cards when balancing a newly prepended batch.
        if (ends[lane] + remaining[lane] < ends[column] + remaining[column])
          column = lane;
      }
    }
    if (existing) remaining[column] -= heights[index];
    const item = {
      id,
      index,
      column,
      top: ends[column],
      height: heights[index],
    };
    ends[column] += item.height;
    lanes[column].push(item);
    return item;
  });
  for (const lane of lanes) {
    lane.forEach((item, index) => {
      item.previousInColumn = lane[index - 1]?.index;
      item.nextInColumn = lane[index + 1]?.index;
    });
  }
  return {
    positions,
    lanes,
    byId: new Map(positions.map((item) => [item.id, item])),
    height: Math.max(0, ...ends),
  };
}

export function visibleMasonry(
  lanes: MasonryPosition[][],
  top: number,
  bottom: number,
) {
  const visible: MasonryPosition[] = [];
  for (const lane of lanes) {
    let low = 0,
      high = lane.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (lane[mid].top + lane[mid].height < top) low = mid + 1;
      else high = mid;
    }
    for (let i = low; i < lane.length && lane[i].top <= bottom; i++)
      visible.push(lane[i]);
  }
  return visible.sort((a, b) => a.index - b.index);
}

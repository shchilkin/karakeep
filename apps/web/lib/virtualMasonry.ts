export interface MasonryPosition {
  id: string;
  index: number;
  column: number;
  top: number;
  height: number;
}

/** Preserve the existing round-robin column order and keyboard indices. */
export function positionMasonry(
  ids: readonly string[],
  columns: number,
  height: (id: string, index: number) => number,
) {
  const lanes: MasonryPosition[][] = Array.from({ length: columns }, () => []);
  const ends = Array<number>(columns).fill(0);
  const positions = ids.map((id, index) => {
    const column = index % columns;
    const item = {
      id,
      index,
      column,
      top: ends[column],
      height: Math.max(1, height(id, index)),
    };
    ends[column] += item.height;
    lanes[column].push(item);
    return item;
  });
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

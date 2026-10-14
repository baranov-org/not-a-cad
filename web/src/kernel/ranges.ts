// Face/edge ranges: [start, count] pairs per B-rep face (index-buffer entries) or edge (line vertices), in the
// order of the shape's faces/edges, so a hit triangle or segment maps to an exact face or edge index

export const toRanges = (groups: { start: number; count: number }[]): Uint32Array => {
  const r = new Uint32Array(groups.length * 2);
  groups.forEach((g, i) => {
    r[2 * i] = g.start;
    r[2 * i + 1] = g.count;
  });
  return r;
};

// Index of the range containing position p (ranges are sorted and contiguous), or -1
export function rangeIndex(ranges: Uint32Array, p: number): number {
  let lo = 0, hi = ranges.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = ranges[2 * mid], end = start + ranges[2 * mid + 1];
    if (p < start) hi = mid - 1;
    else if (p >= end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

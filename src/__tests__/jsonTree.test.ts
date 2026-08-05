/**
 * Guards the row cap. A response like jsonplaceholder's /photos is 5000 objects
 * (~30k nodes); handing all of those to a variable-height FlatList blocks the JS
 * thread long enough that expand/collapse looks broken.
 */

import { buildRows, MAX_ROWS, type Json } from '../components/JsonTree';

/** Same shape as jsonplaceholder.typicode.com/photos. */
const photos = (n: number): Json =>
  Array.from({ length: n }, (_, i) => ({
    albumId: Math.ceil((i + 1) / 50),
    id: i + 1,
    title: 'accusamus ea aliquid et amet sequi nemo',
    url: 'https://via.placeholder.com/600/56a8c2',
    thumbnailUrl: 'https://via.placeholder.com/150/56a8c2',
  })) as Json;

describe('buildRows row cap', () => {
  it('caps a huge payload instead of emitting every node', () => {
    const rows = buildRows(photos(5000), new Set(), 99, null);
    expect(rows.length).toBe(MAX_ROWS);
  });

  it('leaves a small payload untouched', () => {
    const rows = buildRows(photos(3), new Set(), 99, null);
    // 1 root + 3 objects + 15 leaves
    expect(rows.length).toBe(19);
    expect(rows.length).toBeLessThan(MAX_ROWS);
  });

  it('collapses to a single row at depth 0', () => {
    expect(buildRows(photos(5000), new Set(), 0, null)).toHaveLength(1);
  });

  it('stays capped while filtering', () => {
    const all = new Set<string>();
    const collect = (v: Json, path: string) => {
      all.add(path);
      if (Array.isArray(v)) v.forEach((c, i) => collect(c, `${path}.${i}`));
      else if (v && typeof v === 'object') {
        for (const [k, c] of Object.entries(v)) collect(c, `${path}.${k}`);
      }
    };
    collect(photos(5000), '$');
    const rows = buildRows(photos(5000), new Set(), 99, all);
    expect(rows.length).toBeLessThanOrEqual(MAX_ROWS);
  });

  it('builds a capped tree fast enough to stay interactive', () => {
    const data = photos(5000);
    const started = Date.now();
    buildRows(data, new Set(), 99, null);
    // Generous ceiling — the point is that it's bounded work, not 30k rows.
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe('lists collapse by default', () => {
  const withList: Json = {
    status: 'ok',
    tags: ['a', 'b', 'c'],
    nested: { list: [1, 2] },
  };
  const find = (rows: ReturnType<typeof buildRows>, path: string) =>
    rows.find((r) => r.path === path);

  it('collapses a nested array but leaves sibling keys visible', () => {
    const rows = buildRows(withList, new Set(), 2, null);
    expect(find(rows, '$.tags')?.expanded).toBe(false);
    expect(find(rows, '$.status')).toBeDefined();
    // Collapsed means its children were never walked.
    expect(find(rows, '$.tags.0')).toBeUndefined();
  });

  it('keeps an array-shaped root open, so a list response shows its items', () => {
    const rows = buildRows(photos(3), new Set(), 2, null);
    expect(find(rows, '$')?.expanded).toBe(true);
    expect(find(rows, '$.0')).toBeDefined();
  });

  it('expand-all overrides the collapse default', () => {
    const rows = buildRows(withList, new Set(), 99, null);
    expect(find(rows, '$.tags')?.expanded).toBe(true);
    expect(find(rows, '$.nested.list')?.expanded).toBe(true);
    expect(find(rows, '$.tags.0')).toBeDefined();
  });

  it('tapping a collapsed list opens only that one', () => {
    const rows = buildRows(withList, new Set(['$.tags']), 2, null);
    expect(find(rows, '$.tags')?.expanded).toBe(true);
    expect(find(rows, '$.nested.list')?.expanded).toBe(false);
  });

  it('still collapses everything at depth 0', () => {
    expect(buildRows(withList, new Set(), 0, null)).toHaveLength(1);
  });
});

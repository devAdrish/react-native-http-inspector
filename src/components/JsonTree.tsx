/**
 * JsonTree — collapsible, searchable JSON viewer for React Native.
 *
 * No dependencies. Renders a *flattened* row list through FlatList instead of
 * nesting Views, so a 5k-node response body stays scrollable on a low-end
 * Android device.
 *
 * Interaction model:
 *   tap a branch      → expand / collapse
 *   tap a leaf        → toggle full value text (long strings truncate to 2 lines)
 *   tap ⧉             → copy the value (pretty-printed if object/array)
 *   long-press a row  → copy the dotted path (e.g. thumbnailImage.cdnUrl)
 *   filter box        → matches keys AND values, auto-expands to every hit
 *
 * Usage:
 *   <JsonTree data={json} rootLabel="response" onCopy={Clipboard.setString} />
 */

import { useCallback, useMemo, useState } from 'react';
import {
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };

type Kind = 'object' | 'array' | 'primitive';

type Row = {
  path: string;
  label: string;
  value: Json;
  depth: number;
  kind: Kind;
  childCount: number;
  expanded: boolean;
};

const ROOT = '$';

const kindOf = (v: Json): Kind =>
  Array.isArray(v)
    ? 'array'
    : v !== null && typeof v === 'object'
      ? 'object'
      : 'primitive';

const entriesOf = (v: Json): [string, Json][] => {
  if (Array.isArray(v)) return v.map((child, i) => [String(i), child]);
  if (v !== null && typeof v === 'object') return Object.entries(v);
  return [];
};

/* ------------------------------------------------------------------ *
 * Flatten the tree into visible rows.
 *
 * `toggled` holds paths the user has flipped, XOR'd against the default
 * open state (depth < expandDepth). That makes "expand all" / "collapse
 * all" a single state write: clear the set, move expandDepth.
 * ------------------------------------------------------------------ */
/**
 * Hard ceiling on rows handed to FlatList. Rows are variable-height (long values
 * truncate to two lines), so there's no getItemLayout to short-circuit measuring
 * — past a few thousand rows the layout pass blocks the JS thread long enough to
 * look like a hang. Deep-diving a 30k-node payload is not a real use case; being
 * able to open one without freezing is.
 */
export const MAX_ROWS = 4000;

/**
 * The depth "expand" jumps to — deeper than any real payload nests. Also the
 * signal that the user asked for everything, which overrides the collapse-lists
 * default below.
 */
const EXPAND_ALL_DEPTH = 99;

/** Node count, abandoned as soon as `limit` is reached — no full walk of a huge payload. */
function countNodes(value: Json, limit: number): number {
  let n = 0;
  const walk = (v: Json) => {
    if (n >= limit) return;
    n++;
    for (const [, child] of entriesOf(v)) {
      if (n >= limit) return;
      walk(child);
    }
  };
  walk(value);
  return n;
}

export function buildRows(
  root: Json,
  toggled: Set<string>,
  expandDepth: number,
  visible: Set<string> | null
): Row[] {
  const rows: Row[] = [];

  const walk = (value: Json, label: string, path: string, depth: number) => {
    if (rows.length >= MAX_ROWS) return;
    if (visible && !visible.has(path)) return;

    const kind = kindOf(value);
    const children = entriesOf(value);

    // Nested arrays start collapsed: a list is usually the bulkiest thing in a
    // payload and rarely what you're looking for, so opening it by default
    // buries the sibling keys that are. Two exemptions — the root, since a
    // list-shaped response would otherwise open as one unhelpful line, and
    // "expand all", which has to mean everything or the button is a lie.
    const expandAll = expandDepth >= EXPAND_ALL_DEPTH;
    const isNestedList = kind === 'array' && depth > 0 && !expandAll;
    const defaultOpen = !isNestedList && depth < expandDepth;

    const expanded =
      kind === 'primitive'
        ? // leaves: "expanded" means show the untruncated string
          visible !== null || toggled.has(path)
        : visible !== null
          ? true // while filtering, every surviving branch is open
          : toggled.has(path)
            ? !defaultOpen
            : defaultOpen;

    rows.push({
      path,
      label,
      value,
      depth,
      kind,
      childCount: children.length,
      expanded,
    });

    if (kind !== 'primitive' && expanded) {
      children.forEach(([key, child]) =>
        walk(child, key, `${path}.${key}`, depth + 1)
      );
    }
  };

  walk(root, ROOT, ROOT, 0);
  return rows;
}

/* ------------------------------------------------------------------ *
 * Which paths survive the filter: any node whose key or primitive value
 * matches, plus all of its ancestors (so you can see where it lives) and
 * all of its descendants (so a key hit reveals the object's contents).
 * ------------------------------------------------------------------ */
function matchSet(root: Json, query: string): Set<string> {
  const needle = query.trim().toLowerCase();
  const visible = new Set<string>();

  const addSubtree = (value: Json, path: string) => {
    visible.add(path);
    entriesOf(value).forEach(([key, child]) =>
      addSubtree(child, `${path}.${key}`)
    );
  };

  const walk = (
    value: Json,
    label: string,
    path: string,
    ancestors: string[]
  ): boolean => {
    const kind = kindOf(value);
    const selfHit =
      label.toLowerCase().includes(needle) ||
      (kind === 'primitive' && String(value).toLowerCase().includes(needle));

    const nextAncestors = [...ancestors, path];
    let childHit = false;
    entriesOf(value).forEach(([key, child]) => {
      if (walk(child, key, `${path}.${key}`, nextAncestors)) childHit = true;
    });

    if (selfHit || childHit) {
      ancestors.forEach((a) => visible.add(a));
      if (selfHit) addSubtree(value, path);
      else visible.add(path);
      return true;
    }
    return false;
  };

  walk(root, ROOT, ROOT, []);
  return visible;
}

/* ------------------------------------------------------------------ */

function Highlight({
  text,
  query,
  style,
  styles,
}: {
  text: string;
  query: string;
  style?: object;
  styles: Styles;
}) {
  const needle = query.trim();
  const at = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;

  if (at < 0) return <Text style={style}>{text}</Text>;

  return (
    <Text style={style}>
      {text.slice(0, at)}
      <Text style={styles.hit}>{text.slice(at, at + needle.length)}</Text>
      {text.slice(at + needle.length)}
    </Text>
  );
}

const leafStyle = (v: Json, styles: Styles) => {
  if (typeof v === 'string') return styles.string;
  if (typeof v === 'number') return styles.number;
  return styles.atom; // boolean | null
};

const leafText = (v: Json) => (typeof v === 'string' ? `"${v}"` : String(v));

const branchText = (row: Row) => {
  if (row.expanded) return row.kind === 'array' ? ' [' : ' {';
  return row.kind === 'array'
    ? ` [… ${row.childCount}]`
    : ` {… ${row.childCount}}`;
};

/* ------------------------------------------------------------------ */

function TreeRow({
  row,
  rootLabel,
  query,
  onToggle,
  onCopyPath,
  onCopyValue,
  styles,
  ripple,
}: {
  row: Row;
  rootLabel: string;
  query: string;
  onToggle: (path: string) => void;
  onCopyPath: (row: Row) => void;
  onCopyValue: (row: Row) => void;
  styles: Styles;
  ripple: string;
}) {
  const branch = row.kind !== 'primitive';
  const label = row.path === ROOT ? rootLabel : row.label;

  return (
    <Pressable
      onPress={() => onToggle(row.path)}
      onLongPress={() => onCopyPath(row)}
      android_ripple={{ color: ripple }}
      style={({ pressed }) => [
        styles.row,
        { paddingLeft: 7 + row.depth * 16 },
        pressed && styles.rowPressed,
      ]}
    >
      <Text style={styles.caret}>
        {branch ? (row.expanded ? '▾' : '▸') : '·'}
      </Text>

      <Text
        style={styles.line}
        numberOfLines={branch || row.expanded ? undefined : 2}
      >
        <Highlight
          text={label}
          query={query}
          style={styles.key}
          styles={styles}
        />
        {branch ? (
          <Text style={styles.meta}>{branchText(row)}</Text>
        ) : (
          <>
            <Text style={styles.meta}>: </Text>
            <Highlight
              text={leafText(row.value)}
              query={query}
              style={leafStyle(row.value, styles)}
              styles={styles}
            />
          </>
        )}
      </Text>

      {/* Copies the value; long-press the row itself for the dotted path. */}
      <TouchableOpacity
        hitSlop={10}
        activeOpacity={0.4}
        onPress={() => onCopyValue(row)}
      >
        <Text style={styles.copy}>⧉</Text>
      </TouchableOpacity>
    </Pressable>
  );
}

/* ------------------------------------------------------------------ */

export type JsonTreeProps = {
  data: Json;
  /** Label shown for the root node. */
  rootLabel?: string;
  /** Levels open on first render. 2 shows top-level keys and their children. */
  initialExpandDepth?: number;
  /** Wire to any clipboard's setString. Copy controls are hidden when omitted. */
  onCopy?: (text: string) => void;
  /** Override any subset of the default dark palette (e.g. for a light theme). */
  colors?: Partial<JsonTreeColors>;
};

export default function JsonTree({
  data,
  rootLabel = 'response',
  initialExpandDepth,
  onCopy,
  colors,
}: JsonTreeProps) {
  const [query, setQuery] = useState('');
  const [toggled, setToggled] = useState<Set<string>>(() => new Set());
  // A depth of 2 opens every child of a top-level array, which on a 5000-element
  // response is the whole tree. Start collapsed when the payload is large enough
  // for that to matter; an explicit prop still wins.
  const [expandDepth, setExpandDepth] = useState(
    () => initialExpandDepth ?? (countNodes(data, MAX_ROWS) >= MAX_ROWS ? 1 : 2)
  );

  const palette = useMemo(() => ({ ...DARK_COLORS, ...colors }), [colors]);
  const styles = useMemo(() => makeStyles(palette), [palette]);

  // Filtering is a full walk per keystroke — fine up to a few thousand
  // nodes. If your payloads are bigger, debounce this by ~150ms.
  const visible = useMemo(
    () => (query.trim() ? matchSet(data, query) : null),
    [data, query]
  );

  const rows = useMemo(
    () => buildRows(data, toggled, expandDepth, visible),
    [data, toggled, expandDepth, visible]
  );

  // buildRows stops at MAX_ROWS, so hitting it exactly means there was more.
  const truncated = rows.length >= MAX_ROWS;

  const toggle = useCallback((path: string) => {
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const setAll = useCallback((depth: number) => {
    setToggled(new Set());
    setExpandDepth(depth);
  }, []);

  const copyPath = useCallback(
    (row: Row) => onCopy?.(row.path.replace(/^\$\.?/, '') || rootLabel),
    [onCopy, rootLabel]
  );

  const copyValue = useCallback(
    (row: Row) =>
      onCopy?.(
        typeof row.value === 'string'
          ? row.value
          : JSON.stringify(row.value, null, 2)
      ),
    [onCopy]
  );

  return (
    <View style={styles.container}>
      <View style={styles.bar}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="filter keys and values"
          placeholderTextColor={palette.dim}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          clearButtonMode="while-editing"
          style={styles.input}
        />
        <Pressable onPress={() => setAll(EXPAND_ALL_DEPTH)} hitSlop={8}>
          <Text style={styles.action}>expand</Text>
        </Pressable>
        <Pressable onPress={() => setAll(0)} hitSlop={8}>
          <Text style={styles.action}>collapse</Text>
        </Pressable>
      </View>

      <Text style={styles.count}>
        {rows.length} {rows.length === 1 ? 'node' : 'nodes'}
        {query.trim() ? ` matching “${query.trim()}”` : ''}
        {truncated ? ` (first ${MAX_ROWS} shown — collapse or filter)` : ''}
      </Text>

      <FlatList
        data={rows}
        keyExtractor={(row, index) => `${index}:${row.path}`}
        renderItem={({ item }) => (
          <TreeRow
            row={item}
            rootLabel={rootLabel}
            query={query}
            onToggle={toggle}
            onCopyPath={copyPath}
            onCopyValue={copyValue}
            styles={styles}
            ripple={palette.ripple}
          />
        )}
        initialNumToRender={40}
        maxToRenderPerBatch={40}
        windowSize={11}
        removeClippedSubviews
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListEmptyComponent={
          <Text style={styles.empty}>No key or value contains that text.</Text>
        }
      />
    </View>
  );
}

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

export type JsonTreeColors = {
  bg: string;
  surface: string;
  border: string;
  text: string;
  dim: string;
  accent: string;
  key: string;
  string: string;
  number: string;
  atom: string;
  hit: string;
  hitText: string;
  copy: string;
  ripple: string;
  pressed: string;
};

const DARK_COLORS: JsonTreeColors = {
  bg: '#0f1419',
  surface: '#1a222b',
  border: '#243038',
  text: '#e6edf3',
  dim: '#5c6773',
  accent: '#5eb1ef',
  key: '#9cdcfe',
  string: '#98c379',
  number: '#d19a66',
  atom: '#c678dd',
  hit: '#e5c07b',
  hitText: '#0f1419',
  copy: '#3f4b56',
  ripple: '#ffffff14',
  pressed: '#ffffff0d',
};

const makeStyles = (c: JsonTreeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },

    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    input: {
      flex: 1,
      height: 40,
      paddingHorizontal: 10,
      borderRadius: 6,
      backgroundColor: c.surface,
      color: c.text,
      fontFamily: mono,
      fontSize: 15,
    },
    action: { color: c.accent, fontSize: 14, letterSpacing: 0.3 },

    count: {
      paddingHorizontal: 12,
      paddingTop: 6,
      paddingBottom: 4,
      color: c.dim,
      fontSize: 12.5,
      fontFamily: mono,
    },

    row: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      paddingRight: 12,
      paddingVertical: 3,
    },
    rowPressed: { backgroundColor: c.pressed },

    caret: {
      width: 16,
      color: c.dim,
      fontSize: 12.5,
      lineHeight: 21,
    },
    line: { flex: 1, fontFamily: mono, fontSize: 14.5, lineHeight: 21 },

    key: { color: c.key },
    meta: { color: c.dim },
    string: { color: c.string },
    number: { color: c.number },
    atom: { color: c.atom },
    hit: { backgroundColor: c.hit, color: c.hitText },

    copy: { color: c.copy, fontSize: 16, paddingLeft: 8, lineHeight: 21 },

    empty: {
      color: c.dim,
      fontFamily: mono,
      fontSize: 14,
      padding: 16,
    },
  });

type Styles = ReturnType<typeof makeStyles>;

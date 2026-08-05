/**
 * HttpInspector — the network inspector screen.
 *
 * List of intercepted requests with a devtools-style layout: status pill, method,
 * url, duration and size. Tap a row to open RequestDetail. Subscribes to the
 * interceptor in ../networkLogger, so in-flight rows settle live.
 *
 * Presentational: it renders wherever the host puts it and never navigates or
 * dismisses itself. A floating button toggles its own light/dark palette.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { resolveCopy } from '../clipboard';
import {
  clearRequests,
  getRequests,
  subscribe as subscribeToNetworkLog,
} from '../networkLogger';
import RequestDetail from './RequestDetail';
import type { NetworkRequest, Palette } from '../theme';
import {
  BOTTOM_PAD,
  MONO,
  ThemeProvider,
  formatDuration,
  formatStatus,
  isFailed,
  isPending,
  methodColor,
  statusColor,
  useTheme,
} from '../theme';

export type HttpInspectorProps = {
  /**
   * Copies text to the clipboard. Optional — the inspector falls back to
   * @react-native-clipboard/clipboard or react-native's own Clipboard if either
   * is available, and hides its copy controls if neither is.
   */
  onCopy?: (text: string) => void;
};

type StatusFilter = 'all' | 'success' | 'error' | 'pending';

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'success', label: '2xx/3xx' },
  { key: 'error', label: '4xx/5xx' },
  { key: 'pending', label: 'Pending' },
];

const formatSize = (bytes?: number) => {
  if (!bytes || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

/**
 * Takes the request, not a bare status: a transport failure has no status at all,
 * so it would match neither 'pending' nor '4xx/5xx' and disappear from every
 * filter but All. Failures belong with the errors.
 */
const matchesFilter = (r: NetworkRequest, filter: StatusFilter) => {
  if (filter === 'all') return true;
  if (filter === 'pending') return isPending(r);
  const status = r.status ?? 0;
  if (filter === 'error') return isFailed(r) || status >= 400;
  return !isPending(r) && !isFailed(r) && status >= 200 && status < 400;
};

const RequestRow: React.FC<{
  request: NetworkRequest;
  onPress: () => void;
  styles: ReturnType<typeof makeStyles>;
  palette: Palette;
}> = ({ request, onPress, styles, palette }) => {
  const pending = isPending(request);
  const color = statusColor(request.status, palette, pending);
  const size = formatSize(request.responseSize);

  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: palette.ripple }}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={[styles.statusBar, { backgroundColor: color }]} />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={[styles.status, { color }]} numberOfLines={1}>
            {formatStatus(request)}
          </Text>
          <Text
            style={[
              styles.method,
              { color: methodColor(request.method, palette) },
            ]}
          >
            {request.method}
          </Text>
          {!!size && <Text style={styles.metaSmall}>{size}</Text>}
          <Text style={[styles.metaSmall, styles.durationRight]}>
            {formatDuration(request)}
          </Text>
        </View>
        <Text style={styles.path} selectable>
          {request.url}
        </Text>
      </View>
    </Pressable>
  );
};

/**
 * Module scope, not inline: FlatList compares component types, so an arrow
 * defined during render would be a new type each time and rebuild every
 * separator. Takes the colour as a prop since it's the only palette dependency.
 */
const separatorStyle = {
  height: StyleSheet.hairlineWidth,
  marginLeft: 14,
} as const;

const Separator: React.FC<{ color: string }> = ({ color }) => (
  <View style={[separatorStyle, { backgroundColor: color }]} />
);

const NetworkLogsList: React.FC<HttpInspectorProps> = ({ onCopy }) => {
  const { palette, name, toggle } = useTheme();
  const copy = useMemo(() => resolveCopy(onCopy), [onCopy]);
  const styles = useMemo(() => makeStyles(palette), [palette]);

  const [selected, setSelected] = useState<NetworkRequest | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [requests, setRequests] = useState<NetworkRequest[]>(() => [
    ...getRequests(),
  ]);

  // The interceptor notifies on every capture and completion (coalesced to one
  // tick), so no polling: the list updates exactly when something changes.
  useEffect(() => {
    const sync = () => setRequests(getRequests());
    sync();
    return subscribeToNetworkLog(sync);
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return requests.filter((r) => {
      if (!matchesFilter(r, filter)) return false;
      if (!needle) return true;
      return `${r.method} ${r.status} ${r.url}`.toLowerCase().includes(needle);
    });
  }, [requests, query, filter]);

  const counts = useMemo(
    () => ({
      total: requests.length,
      errors: requests.filter((r) => isFailed(r) || (r.status ?? 0) >= 400)
        .length,
    }),
    [requests]
  );

  const onClear = useCallback(() => {
    clearRequests();
    setRequests([]);
    setSelected(null);
  }, []);

  // Stable across renders as long as the palette holds, so FlatList doesn't
  // remount separators on every state change.
  const renderSeparator = useCallback(
    () => <Separator color={palette.border} />,
    [palette.border]
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        {/* Returns from a request to the list. Dismissing the inspector itself is
            the host's job — it owns however this got on screen. */}
        {selected && (
          <Pressable
            onPress={() => setSelected(null)}
            hitSlop={12}
            style={styles.backBtn}
          >
            <Text style={styles.backIcon}>←</Text>
          </Pressable>
        )}
        <View style={styles.headerTitles}>
          <Text style={styles.title}>{selected ? 'Request' : 'Network'}</Text>
          {!selected && (
            <Text style={styles.subtitle}>
              {counts.total} {counts.total === 1 ? 'request' : 'requests'}
              {counts.errors ? ` · ${counts.errors} failed` : ''}
            </Text>
          )}
        </View>
        {!selected && (
          <Pressable onPress={onClear} hitSlop={10}>
            <Text style={styles.clear}>Clear</Text>
          </Pressable>
        )}
      </View>

      {selected ? (
        <RequestDetail request={selected} onCopy={copy} />
      ) : (
        <>
          <View style={styles.toolbar}>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Filter by url, method or status"
              placeholderTextColor={palette.dim}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              clearButtonMode="while-editing"
              style={styles.input}
            />
          </View>

          <View style={styles.chips}>
            {FILTERS.map((f) => {
              const active = f.key === filter;
              return (
                <Pressable
                  key={f.key}
                  onPress={() => setFilter(f.key)}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text
                    style={[styles.chipText, active && styles.chipTextActive]}
                  >
                    {f.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <FlatList
            data={filtered}
            keyExtractor={(r) => r.id}
            renderItem={({ item }) => (
              <RequestRow
                request={item}
                onPress={() => setSelected(item)}
                styles={styles}
                palette={palette}
              />
            )}
            ItemSeparatorComponent={renderSeparator}
            contentContainerStyle={
              filtered.length ? styles.listContent : styles.listEmptyContent
            }
            initialNumToRender={16}
            windowSize={9}
            removeClippedSubviews
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            ListEmptyComponent={
              <View style={styles.emptyWrap}>
                <Text style={styles.emptyTitle}>
                  {requests.length ? 'No matches' : 'No requests yet'}
                </Text>
                <Text style={styles.emptyBody}>
                  {requests.length
                    ? 'Try a different search or filter.'
                    : 'Navigate the app — intercepted requests appear here.'}
                </Text>
              </View>
            }
          />
        </>
      )}

      <Pressable
        onPress={toggle}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Switch to ${name === 'dark' ? 'light' : 'dark'} theme`}
        style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
      >
        <Text style={styles.fabIcon}>{name === 'dark' ? '☀' : '☾'}</Text>
      </Pressable>
    </View>
  );
};

const HttpInspector: React.FC<HttpInspectorProps> = ({ onCopy }) => (
  <ThemeProvider>
    <NetworkLogsList onCopy={onCopy} />
  </ThemeProvider>
);

export default HttpInspector;

const makeStyles = (p: Palette) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: p.bg },

    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    backBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: p.surface,
    },
    backIcon: { color: p.text, fontSize: 20, lineHeight: 22 },
    headerTitles: { flex: 1 },
    title: {
      color: p.text,
      fontSize: 22,
      fontWeight: '700',
      letterSpacing: 0.2,
    },
    subtitle: { color: p.dim, fontSize: 15, fontFamily: MONO, marginTop: 2 },
    clear: { color: p.accent, fontSize: 17, fontWeight: '600' },

    toolbar: { paddingHorizontal: 14, paddingBottom: 8 },
    input: {
      height: 46,
      paddingHorizontal: 12,
      borderRadius: 10,
      backgroundColor: p.surface,
      color: p.text,
      fontFamily: MONO,
      fontSize: 17,
    },

    chips: {
      flexDirection: 'row',
      gap: 8,
      paddingHorizontal: 14,
      paddingBottom: 10,
    },
    chip: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 8,
      backgroundColor: p.surface,
    },
    chipActive: { backgroundColor: p.accent + '26' },
    chipText: { fontSize: 15.5, color: p.dim, fontWeight: '600' },
    chipTextActive: { color: p.accent },

    listContent: { paddingBottom: BOTTOM_PAD },
    listEmptyContent: {
      flexGrow: 1,
      justifyContent: 'center',
      paddingBottom: BOTTOM_PAD,
    },

    row: { flexDirection: 'row', alignItems: 'stretch', paddingRight: 14 },
    rowPressed: { backgroundColor: p.pressed },
    statusBar: {
      width: 3,
      borderRadius: 2,
      marginVertical: 10,
      marginRight: 11,
      marginLeft: 11,
    },
    rowBody: { flex: 1, paddingVertical: 10 },
    rowTop: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      marginBottom: 3,
    },
    status: { fontFamily: MONO, fontSize: 15.5, fontWeight: '700' },
    method: {
      fontFamily: MONO,
      fontSize: 14,
      fontWeight: '700',
      letterSpacing: 0.4,
    },
    path: { color: p.text, fontFamily: MONO, fontSize: 16, lineHeight: 23 },
    metaSmall: { color: p.dim, fontFamily: MONO, fontSize: 14 },
    durationRight: { marginLeft: 'auto' },

    emptyWrap: { alignItems: 'center', paddingHorizontal: 40 },
    emptyTitle: {
      color: p.text,
      fontSize: 19.5,
      fontWeight: '600',
      marginBottom: 6,
    },
    emptyBody: {
      color: p.dim,
      fontSize: 16,
      textAlign: 'center',
      lineHeight: 23,
    },

    fab: {
      position: 'absolute',
      right: 18,
      // Anchors the absolute position; deliberately not inset-aware. Wrap the
      // inspector in an inset-aware view if it needs to clear a home indicator.
      bottom: 16,
      width: 48,
      height: 48,
      borderRadius: 24,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: p.surface,
      borderWidth: 1,
      borderColor: p.border,
      // Modest elevation: enough to sit above the list, low enough that a host's
      // own floating UI can still layer over it.
      elevation: 6,
      shadowColor: '#000',
      shadowOpacity: 0.3,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 2 },
    },
    fabPressed: { backgroundColor: p.border, transform: [{ scale: 0.94 }] },
    fabIcon: { fontSize: 22, color: p.accent },
  });

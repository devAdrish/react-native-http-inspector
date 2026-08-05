/**
 * RequestDetail — single request inspector for the network logger.
 *
 * Three tabs: Overview (timing/size/status + curl), Request (headers + body),
 * Response (headers + body). JSON bodies render through JsonTree; anything
 * that isn't JSON falls back to selectable monospace text.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { getRequestBody, getResponseBody, toCurl } from '../networkLogger';
import type { NetworkRequest, Palette } from '../theme';
import {
  BOTTOM_PAD,
  MONO,
  formatDuration,
  formatStatus,
  isPending,
  methodColor,
  statusColor,
  useTheme,
} from '../theme';
import JsonTree from './JsonTree';

type Styles = ReturnType<typeof makeStyles>;

type Tab = 'overview' | 'request' | 'response';

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'request', label: 'Request' },
  { key: 'response', label: 'Response' },
];

type ParsedBody =
  /** Renders through JsonTree — objects and arrays only. */
  | { kind: 'tree'; json: AnyType; raw: string }
  /** Anything with no structure to expand: text, html, scalars, unparseable. */
  | { kind: 'text'; raw: string; note?: string }
  /** Genuinely nothing came back. */
  | { kind: 'empty'; note: string };

/**
 * Classify a response/request body for display. Never throws, and always yields
 * something renderable — a body that produced no text still reports *why*
 * rather than rendering an empty panel.
 */
function parseBody(body: unknown): ParsedBody {
  if (body === undefined) return { kind: 'empty', note: 'No body.' };
  if (body === null) return { kind: 'text', raw: 'null', note: 'null body' };
  if (typeof body === 'string' && body.trim() === '') {
    return {
      kind: 'empty',
      note: body === '' ? 'No body.' : 'Body is whitespace only.',
    };
  }

  // Already-decoded payloads (the library hands back objects for some types).
  if (typeof body !== 'string') {
    if (typeof body === 'object') {
      // stringify returns undefined for non-serializable values, and throws on
      // circular refs — fall back to String() so something always shows.
      try {
        const raw = JSON.stringify(body, null, 2);
        if (raw === undefined)
          return {
            kind: 'text',
            raw: String(body),
            note: 'not JSON-serializable',
          };
        return { kind: 'tree', json: body, raw };
      } catch {
        return {
          kind: 'text',
          raw: String(body),
          note: 'circular or non-serializable',
        };
      }
    }
    // number | boolean | bigint | symbol | function
    return { kind: 'text', raw: String(body), note: typeof body };
  }

  try {
    const json = JSON.parse(body);
    // Scalars parse successfully but have no tree to show — keep them as text so
    // "null", "123" and "false" render instead of falling through to an empty panel.
    if (json !== null && typeof json === 'object')
      return { kind: 'tree', json, raw: body };
    return {
      kind: 'text',
      raw: body,
      note: `JSON ${json === null ? 'null' : typeof json}`,
    };
  } catch {
    return { kind: 'text', raw: body };
  }
}

/** What Copy puts on the clipboard — exactly the text the panel displays. */
const bodyText = (body: unknown) => {
  const parsed = parseBody(body);
  return parsed.kind === 'empty' ? '' : parsed.raw;
};

const formatBytes = (bytes?: number) => {
  if (!bytes || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

const formatTime = (ms: number) => {
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

const Row: React.FC<{
  label: string;
  value: string;
  valueColor?: string;
  styles: Styles;
}> = ({ label, value, valueColor, styles }) => (
  <View style={styles.metaRow}>
    <Text style={styles.metaLabel}>{label}</Text>
    <Text
      style={[styles.metaValue, !!valueColor && { color: valueColor }]}
      selectable
    >
      {value}
    </Text>
  </View>
);

const SectionTitle: React.FC<{
  title: string;
  action?: string;
  onAction?: () => void;
  styles: Styles;
}> = ({ title, action, onAction, styles }) => (
  <View style={styles.sectionHead}>
    <Text style={styles.sectionTitle}>{title}</Text>
    {!!action && (
      <Pressable onPress={onAction} hitSlop={8}>
        <Text style={styles.sectionAction}>{action}</Text>
      </Pressable>
    )}
  </View>
);

const Headers: React.FC<{
  headers?: Record<string, string>;
  styles: Styles;
}> = ({ headers, styles }) => {
  const entries = Object.entries(headers || {});
  if (!entries.length) return <Text style={styles.empty}>No headers.</Text>;

  return (
    <View style={styles.headerBlock}>
      {entries.map(([key, value]) => (
        <View key={key} style={styles.headerRow}>
          <Text style={styles.headerKey} selectable>
            {key}
          </Text>
          <Text style={styles.headerValue} selectable>
            {String(value)}
          </Text>
        </View>
      ))}
    </View>
  );
};

/** Long single-line payloads (base64, minified blobs) get clipped for display. */
const PREVIEW_LIMIT = 2000;

const clip = (text: string) =>
  text.length <= PREVIEW_LIMIT
    ? { text, note: undefined }
    : {
        text: text.slice(0, PREVIEW_LIMIT),
        note: `showing first ${PREVIEW_LIMIT} of ${text.length} chars — Copy takes the full body`,
      };

/**
 * Read a body to displayable text.
 *
 * Always async when a reader is supplied, rather than sniffing the value's shape
 * first: `responseType` may be 'blob', 'text', 'json' or '' depending on how the
 * caller configured the XHR, and a blob keeps its bytes in native memory so the
 * JS side sees only a {_data, blobId} handle. getResponseBody() resolves every
 * one of those cases (FileReader for blobs, passthrough otherwise), so routing
 * through it unconditionally is correct where guessing the shape was not.
 */
const useResolvedBody = (resolve?: () => Promise<string>) => {
  const [resolved, setResolved] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!resolve) return;
    let alive = true;
    setResolved(null);
    setFailed(null);
    resolve().then(
      (text) => alive && setResolved(text ?? ''),
      (e: AnyType) =>
        alive && setFailed(String(e?.message || e || 'could not read body'))
    );
    return () => {
      alive = false;
    };
  }, [resolve]);

  return { resolved, failed };
};

/** Body panel: JsonTree when the payload parsed as an object, raw text otherwise. */
const Body: React.FC<{
  body: unknown;
  label: string;
  onCopy?: (text: string) => void;
  styles: Styles;
  palette: Palette;
  /** Library reader (request.getResponseBody) — preferred over `body` when given. */
  resolve?: () => Promise<string>;
}> = ({ body, label, onCopy, styles, palette, resolve }) => {
  const { resolved, failed } = useResolvedBody(resolve);

  // Prefer the reader's text; fall back to the raw value when no reader is given
  // (the request tab, where requestBody is never blob-backed).
  const parsed = useMemo(
    () => parseBody(resolve ? resolved : body),
    [resolve, resolved, body]
  );

  // The tree carries its own dark defaults, so hand it the logger's palette to
  // keep it in step with the light/dark toggle.
  const treeColors = useMemo(
    () => ({
      bg: palette.bg,
      surface: palette.surface,
      border: palette.border,
      text: palette.text,
      dim: palette.dim,
      accent: palette.accent,
      key: palette.key,
      string: palette.string,
      number: palette.number,
      atom: palette.atom,
      hit: palette.hit,
      hitText: palette.hitText,
      copy: palette.dim,
      ripple: palette.ripple,
      pressed: palette.pressed,
    }),
    [palette]
  );

  if (resolve && failed)
    return <Text style={styles.empty}>Could not read body — {failed}</Text>;
  if (resolve && resolved === null)
    return <Text style={styles.empty}>Reading body…</Text>;

  if (parsed.kind === 'empty')
    return <Text style={styles.empty}>{parsed.note}</Text>;

  if (parsed.kind === 'tree') {
    return (
      <View style={styles.treeWrap}>
        <JsonTree
          data={parsed.json}
          rootLabel={label}
          onCopy={onCopy}
          colors={treeColors}
        />
      </View>
    );
  }

  // Clip for display only — long press and Copy still hand over the full text.
  const preview = clip(parsed.raw);
  const note = [parsed.note, preview.note].filter(Boolean).join(' · ');

  return (
    <View style={styles.rawWrap}>
      {!!note && <Text style={styles.rawNote}>{note}</Text>}
      <ScrollView contentContainerStyle={styles.rawInner}>
        <Pressable onLongPress={() => onCopy?.(parsed.raw)}>
          <Text style={styles.raw} selectable>
            {preview.text}
          </Text>
        </Pressable>
      </ScrollView>
    </View>
  );
};

const RequestDetail: React.FC<{
  request: NetworkRequest;
  onCopy?: (text: string) => void;
}> = ({ request, onCopy }) => {
  const [tab, setTab] = useState<Tab>('response');
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  const status = request.status;
  const statusHue = statusColor(status, palette, isPending(request));
  const methodHue = methodColor(request.method, palette);

  // Stable identity so Body's resolve effect doesn't re-run every render.
  const resolveResponse = useCallback(
    () => getResponseBody(request),
    [request]
  );

  // Copy needs the same blob-aware read as the panel, so it can't be synchronous.
  const copyResponse = useCallback(
    () =>
      getResponseBody(request).then(
        (text) => onCopy?.(text),
        () => onCopy?.('')
      ),
    [request, onCopy]
  );

  return (
    <View style={styles.container}>
      {/* summary card */}
      <View style={styles.summary}>
        <View style={styles.summaryTop}>
          <View
            style={[
              styles.pill,
              { backgroundColor: statusHue + '22', borderColor: statusHue },
            ]}
          >
            <Text style={[styles.pillText, { color: statusHue }]}>
              {formatStatus(request)}
            </Text>
          </View>
          <Text style={[styles.method, { color: methodHue }]}>
            {request.method}
          </Text>
          <Text style={styles.duration}>{formatDuration(request)}</Text>
        </View>
        <Text style={styles.url} selectable>
          {request.url}
        </Text>
      </View>

      {/* tabs */}
      <View style={styles.tabs}>
        {TABS.map((t) => {
          const active = t.key === tab;
          return (
            <Pressable
              key={t.key}
              onPress={() => setTab(t.key)}
              style={[styles.tab, active && styles.tabActive]}
            >
              <Text style={[styles.tabText, active && styles.tabTextActive]}>
                {t.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {tab === 'overview' && (
        <ScrollView contentContainerStyle={styles.overview}>
          <SectionTitle title="General" styles={styles} />
          <Row label="URL" value={request.url} styles={styles} />
          <Row
            label="Method"
            value={request.method}
            valueColor={methodHue}
            styles={styles}
          />
          <Row
            label="Status"
            value={formatStatus(request)}
            valueColor={statusHue}
            styles={styles}
          />
          <Row
            label="Type"
            value={request.responseContentType || request.responseType || '—'}
            styles={styles}
          />
          <SectionTitle title="Timing" styles={styles} />
          <Row
            label="Started"
            value={formatTime(request.startTime)}
            styles={styles}
          />
          <Row
            label="Duration"
            value={formatDuration(request)}
            styles={styles}
          />
          <SectionTitle title="Size" styles={styles} />
          <Row
            label="Response"
            value={formatBytes(request.responseSize)}
            styles={styles}
          />
          <SectionTitle
            title="cURL"
            action={onCopy ? 'Copy' : undefined}
            onAction={() => onCopy?.(toCurl(request))}
            styles={styles}
          />
          <Text style={styles.curl} selectable>
            {toCurl(request)}
          </Text>
        </ScrollView>
      )}

      {tab === 'request' && (
        <View style={styles.pane}>
          <SectionTitle
            title={`Request headers (${Object.keys(request.requestHeaders || {}).length})`}
            action={onCopy ? 'Copy' : undefined}
            onAction={() =>
              onCopy?.(JSON.stringify(request.requestHeaders || {}, null, 2))
            }
            styles={styles}
          />
          <ScrollView
            style={styles.headerPane}
            contentContainerStyle={styles.headerPaneInner}
            nestedScrollEnabled
          >
            <Headers headers={request.requestHeaders} styles={styles} />
          </ScrollView>
          <View style={styles.divider} />
          <SectionTitle
            title="Request body"
            action={onCopy ? 'Copy' : undefined}
            onAction={() =>
              onCopy?.(getRequestBody(request) || bodyText(request.requestBody))
            }
            styles={styles}
          />
          <Body
            body={request.requestBody}
            label="data"
            onCopy={onCopy}
            styles={styles}
            palette={palette}
          />
        </View>
      )}

      {tab === 'response' && (
        <View style={styles.pane}>
          <SectionTitle
            title={`Response headers (${Object.keys(request.responseHeaders || {}).length})`}
            action={onCopy ? 'Copy' : undefined}
            onAction={() =>
              onCopy?.(JSON.stringify(request.responseHeaders || {}, null, 2))
            }
            styles={styles}
          />
          <ScrollView
            style={styles.headerPane}
            contentContainerStyle={styles.headerPaneInner}
            nestedScrollEnabled
          >
            <Headers headers={request.responseHeaders} styles={styles} />
          </ScrollView>
          <View style={styles.divider} />
          <SectionTitle
            title="Response body"
            action={onCopy ? 'Copy' : undefined}
            onAction={copyResponse}
            styles={styles}
          />
          <Body
            body={request.response}
            label="data"
            onCopy={onCopy}
            styles={styles}
            palette={palette}
            resolve={resolveResponse}
          />
        </View>
      )}
    </View>
  );
};

export default RequestDetail;

const makeStyles = (p: Palette) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: p.bg },

    summary: {
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: p.border,
    },
    summaryTop: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      marginBottom: 8,
    },
    pill: {
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 6,
      borderWidth: 1,
    },
    pillText: { fontFamily: MONO, fontSize: 12.5, fontWeight: '700' },
    method: {
      fontFamily: MONO,
      fontSize: 12.5,
      fontWeight: '700',
      letterSpacing: 0.5,
    },
    duration: {
      marginLeft: 'auto',
      fontFamily: MONO,
      fontSize: 11.5,
      color: p.dim,
    },
    url: { fontFamily: MONO, fontSize: 13.5, lineHeight: 20, color: p.text },

    tabs: {
      flexDirection: 'row',
      paddingHorizontal: 12,
      paddingTop: 10,
      gap: 6,
    },
    tab: {
      paddingHorizontal: 14,
      paddingVertical: 7,
      borderRadius: 8,
      backgroundColor: p.surface,
    },
    tabActive: { backgroundColor: p.accent + '26' },
    tabText: { fontSize: 13, color: p.dim, fontWeight: '600' },
    tabTextActive: { color: p.accent },

    overview: { padding: 16, paddingBottom: BOTTOM_PAD },
    sectionHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 18,
      marginBottom: 8,
      paddingHorizontal: 4,
    },
    sectionTitle: {
      fontSize: 11,
      letterSpacing: 1.1,
      textTransform: 'uppercase',
      color: p.dim,
      fontWeight: '700',
    },
    sectionAction: { fontSize: 12, color: p.accent, fontWeight: '600' },

    metaRow: { flexDirection: 'row', paddingVertical: 5, gap: 12 },
    metaLabel: { width: 82, fontSize: 12.5, color: p.dim, fontFamily: MONO },
    metaValue: {
      flex: 1,
      fontSize: 12.5,
      color: p.text,
      fontFamily: MONO,
      lineHeight: 18,
    },

    headerBlock: { paddingHorizontal: 4 },
    headerRow: { paddingVertical: 4 },
    headerKey: { fontFamily: MONO, fontSize: 12, color: p.key },
    headerValue: {
      fontFamily: MONO,
      fontSize: 12,
      color: p.text,
      lineHeight: 17,
    },

    pane: { flex: 1, paddingHorizontal: 12 },
    // Fixed slice for headers — scrolls internally, every header still reachable —
    // so the body below always gets the same generous remainder.
    headerPane: { height: 150, flexGrow: 0, flexShrink: 0 },
    headerPaneInner: { paddingBottom: 4 },
    divider: {
      height: 1,
      backgroundColor: p.border,
      marginTop: 10,
      marginHorizontal: -12,
    },

    // The tree renders its own surface, so give it a framed edge to divide it
    // from the section title above rather than letting the backgrounds merge.
    treeWrap: {
      flex: 1,
      borderRadius: 10,
      overflow: 'hidden',
      marginBottom: BOTTOM_PAD,
      marginTop: 8,
      borderWidth: 1,
      borderColor: p.border,
    },
    rawWrap: {
      flex: 1,
      backgroundColor: p.surface,
      borderRadius: 10,
      marginBottom: BOTTOM_PAD,
      marginTop: 8,
    },
    rawInner: { padding: 12, paddingBottom: BOTTOM_PAD },
    rawNote: {
      fontFamily: MONO,
      fontSize: 10.5,
      color: p.dim,
      paddingHorizontal: 12,
      paddingTop: 8,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    },
    raw: { fontFamily: MONO, fontSize: 12.5, lineHeight: 18, color: p.text },

    curl: {
      fontFamily: MONO,
      fontSize: 12,
      lineHeight: 18,
      color: p.string,
      backgroundColor: p.surface,
      borderRadius: 10,
      padding: 12,
    },
    empty: { fontFamily: MONO, fontSize: 12.5, color: p.dim, padding: 8 },
  });

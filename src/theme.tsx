/**
 * Palette + helpers shared by the network logger list and detail views.
 *
 * Deliberately hardcoded rather than derived from the host app's theme — this is
 * a debugging surface that mimics a browser devtools network panel, so it
 * carries its own light/dark pair. Defaults to light.
 *
 * Styles here are built per-palette by `makeStyles` factories in each file
 * rather than module-level StyleSheet.create, because StyleSheet.create runs
 * once at import and would freeze whichever palette was active first.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import { Platform } from 'react-native';
import type { NetworkLogEntry } from './networkLogger';

export type NetworkRequest = NetworkLogEntry;

export const MONO = Platform.select({ ios: 'Meo', default: 'monospace' });

/** Trailing space so the last row/node isn't hidden behind the theme-toggle FAB. */
export const BOTTOM_PAD = 60;

type RequestLike = Pick<
  NetworkLogEntry,
  'endTime' | 'status' | 'duration' | 'failure'
>;

/** Still in flight: nothing has completed the entry yet. */
export const isPending = (r: RequestLike) => r.endTime === undefined;

/**
 * Finished without an HTTP status — connection refused, DNS failure, timeout or
 * abort. Our interceptor records this as an explicit `failure` reason instead of
 * the status 0/-1 the old package left behind.
 */
export const isFailed = (r: RequestLike) =>
  !isPending(r) && (!!r.failure || !(r.status && r.status > 0));

/** Status column text: the code, 'pending' while in flight, else the failure. */
export const formatStatus = (r: RequestLike) => {
  if (isPending(r)) return 'pending';
  if (isFailed(r)) return r.failure ?? 'failed';
  return String(r.status);
};

export const formatDuration = (r: RequestLike) => {
  if (isPending(r)) return 'pending';
  const ms = r.duration;
  if (ms === undefined || ms < 0) return '—';
  return `${ms} ms`;
};

export type Palette = {
  bg: string;
  surface: string;
  surfaceAlt: string;
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
  success: string;
  warn: string;
  error: string;
  pending: string;
  pendingStatus: string;
  ripple: string;
  pressed: string;
};

const DARK: Palette = {
  bg: '#0f1419',
  surface: '#1a222b',
  surfaceAlt: '#151d25',
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
  success: '#4ec9a0',
  warn: '#e5c07b',
  error: '#f07178',
  pending: '#8a95a1',
  /** Status text for an in-flight request — amber reads as "working", not "broken". */
  pendingStatus: '#e0902f',
  ripple: '#ffffff14',
  pressed: '#ffffff0d',
};

/**
 * Light values are re-picked rather than inverted — the dark syntax colors are
 * tuned for a dark ground and wash out badly on white, so each gets a darker,
 * higher-contrast sibling.
 */
const LIGHT: Palette = {
  bg: '#ffffff',
  surface: '#f1f3f5',
  surfaceAlt: '#f8f9fa',
  border: '#dfe3e8',
  text: '#1b1f24',
  dim: '#6b7681',
  accent: '#0a69c7',
  key: '#0451a5',
  string: '#227b22',
  number: '#a4552b',
  atom: '#7c3aad',
  hit: '#ffe08a',
  hitText: '#1b1f24',
  success: '#137a55',
  warn: '#9a6a00',
  error: '#c62f37',
  pending: '#7a848f',
  pendingStatus: '#b06a00',
  ripple: '#00000012',
  pressed: '#0000000a',
};

export type ThemeName = 'dark' | 'light';

type ThemeValue = {
  palette: Palette;
  name: ThemeName;
  toggle: () => void;
};

const ThemeContext = createContext<ThemeValue>({
  palette: LIGHT,
  name: 'light',
  toggle: () => {},
});

/**
 * Module-level so the choice survives unmounting the inspector within a session.
 * Not persisted across reloads — that would need a storage dependency this
 * package deliberately doesn't take.
 */
let dtheme: 'dark' | 'light' = 'light';

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [name, setName] = useState<ThemeName>(dtheme);

  const toggle = useCallback(
    () =>
      setName((prev) => {
        const next = prev === 'dark' ? 'light' : 'dark';
        dtheme = next;
        return next;
      }),
    []
  );

  const value = useMemo(
    () => ({ palette: name === 'dark' ? DARK : LIGHT, name, toggle }),
    [name, toggle]
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
};

export const useTheme = () => useContext(ThemeContext);

/**
 * 2xx green, 3xx blue, 4xx amber, 5xx red, in-flight grey, transport failure red.
 *
 * The `<= 0` guard matters: a failed request carries status 0 or -1, and without
 * it `-1 < 300` painted network errors the same green as a success.
 */
export const statusColor = (
  status: number | undefined,
  p: Palette,
  pending = false
) => {
  if (pending) return p.pendingStatus;
  // Reached oy for a finished request, so a missing/negative status is a
  // transport failure — red, matching the 'failed' label.
  if (!status || status < 0) return p.error;
  if (status < 300) return p.success;
  if (status < 400) return p.accent;
  if (status < 500) return p.warn;
  return p.error;
};

export const methodColor = (method: string | undefined, p: Palette) => {
  switch (method) {
    case 'GET':
      return p.accent;
    case 'POST':
      return p.success;
    case 'PUT':
    case 'PATCH':
      return p.warn;
    case 'DELETE':
      return p.error;
    default:
      return p.dim;
  }
};

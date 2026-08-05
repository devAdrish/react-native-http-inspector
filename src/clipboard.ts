/**
 * Clipboard resolution, so the package needs no clipboard peer dependency.
 *
 * Three sources, in order:
 *   1. an `onCopy` passed to <HttpInspector> by the host
 *   2. @react-native-clipboard/clipboard, if the host happens to have it
 *   3. react-native's own Clipboard — deprecated but still functional
 *
 * If none resolve, copy controls are hidden rather than silently doing nothing.
 *
 * require() rather than import: a static import of an uninstalled package is a
 * Metro resolution error at bundle time, which is exactly what we're avoiding.
 * Wrapped in try/catch because require throws when the module is absent.
 */

type Copy = (text: string) => void;

const fromCommunityPackage = (): Copy | undefined => {
  try {
    const mod = require('@react-native-clipboard/clipboard');
    const clipboard = mod?.default ?? mod;
    if (typeof clipboard?.setString === 'function') {
      return (text: string) => clipboard.setString(text);
    }
  } catch {
    /* not installed */
  }
  return undefined;
};

const fromReactNativeCore = (): Copy | undefined => {
  try {
    // Deprecated and destined for removal, but present and working through at
    // least RN 0.85 — worth using when the host has nothing better.
    const { Clipboard } = require('react-native');
    if (typeof Clipboard?.setString === 'function') {
      return (text: string) => Clipboard.setString(text);
    }
  } catch {
    /* gone from core */
  }
  return undefined;
};

/** Resolved once at import: neither source can appear later in a session. */
const detected: Copy | undefined =
  fromCommunityPackage() ?? fromReactNativeCore();

/**
 * The copy function to use, or undefined when nothing can copy — callers should
 * hide their copy affordances in that case.
 */
export const resolveCopy = (override?: Copy): Copy | undefined =>
  override ?? detected;

/** Whether anything at all can copy, absent a host-provided override. */
export const canCopy = detected !== undefined;

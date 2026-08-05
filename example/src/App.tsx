/**
 * Demo app for react-native-http-inspector.
 *
 * Start the interceptor once at module scope, then render <HttpInspector>
 * wherever you want it. The inspector is presentational: it doesn't navigate or
 * dismiss itself, so the trigger button and the show/hide state below are the
 * app's own — swap the Modal for a navigator screen and nothing changes.
 */

import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  HttpInspector,
  startNetworkLogging,
} from 'react-native-http-inspector';

// Start before any request is made — the interceptor only captures traffic that
// happens after it patches XMLHttpRequest. Module scope runs once, on import.
startNetworkLogging({
  // The RN dev server constantly hits /symbolicate and /message; leaving those
  // in drowns out the app's own traffic.
  ignoredHosts: ['localhost', '10.0.2.2'],
});

/**
 * The inspector applies no safe-area padding of its own — insets are the host
 * app's call. A real app would use react-native-safe-area-context here; this
 * approximates it without pulling in a dependency just for the demo.
 */
const TOP_INSET = Platform.select({
  ios: 47, // status bar + notch on a modern iPhone
  android: StatusBar.currentHeight ?? 24,
  default: 0,
});
const BOTTOM_INSET = Platform.OS === 'ios' ? 34 : 0; // home indicator

type Demo = {
  label: string;
  run: () => Promise<unknown>;
};

const DEMOS: Demo[] = [
  {
    label: 'GET · 200 json',
    run: () =>
      fetch('https://jsonplaceholder.typicode.com/todos/1').then((r) =>
        r.json()
      ),
  },
  {
    label: 'POST · 201 with body',
    run: () =>
      fetch('https://jsonplaceholder.typicode.com/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'inspector', body: 'hello', userId: 1 }),
      }).then((r) => r.json()),
  },
  {
    label: 'GET · 404 not found',
    run: () => fetch('https://jsonplaceholder.typicode.com/nope'),
  },
  {
    label: 'GET · 500 server error',
    run: () => fetch('https://httpbin.org/status/500'),
  },
  {
    label: 'GET · large payload (100 items)',
    // _limit keeps this at ~600 nodes. The unbounded /photos is 5000 items /
    // 30k nodes — enough to bog down any tree view, and not a realistic response.
    run: () =>
      fetch('https://jsonplaceholder.typicode.com/photos?_limit=100').then(
        (r) => r.json()
      ),
  },
  {
    label: 'Transport failure (bad host)',
    // No such host — shows up as a failure, not a status 0 row.
    run: () => fetch('https://this-host-does-not-exist.invalid/x'),
  },
  {
    label: 'Slow request (3s delay)',
    run: () => fetch('https://httpbin.org/delay/3'),
  },
];

export default function App() {
  const [showInspector, setShowInspector] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const fire = useCallback(async (demo: Demo) => {
    setBusy(demo.label);
    try {
      await demo.run();
    } catch {
      // Swallowed on purpose: the failure is the point, and the inspector has
      // already recorded it. An unhandled rejection would just noise up the
      // console.
    } finally {
      setBusy(null);
    }
  }, []);

  const fireAll = useCallback(() => {
    // Fired in parallel so the list shows several rows settling at once.
    DEMOS.forEach((d) => {
      d.run().catch(() => {});
    });
  }, []);

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>HTTP Inspector</Text>
        <Text style={styles.subtitle}>
          Fire some requests, then tap the floating button to inspect them.
        </Text>

        {DEMOS.map((demo) => (
          <Pressable
            key={demo.label}
            onPress={() => fire(demo)}
            style={({ pressed }) => [
              styles.button,
              pressed && styles.buttonPressed,
            ]}
          >
            <Text style={styles.buttonText}>{demo.label}</Text>
            {busy === demo.label && (
              <ActivityIndicator size="small" color="#4f39ef" />
            )}
          </Pressable>
        ))}

        <Pressable
          onPress={fireAll}
          style={({ pressed }) => [
            styles.button,
            styles.buttonPrimary,
            pressed && styles.buttonPressed,
          ]}
        >
          <Text style={[styles.buttonText, styles.buttonPrimaryText]}>
            Fire all at once
          </Text>
        </Pressable>
      </ScrollView>

      {/* The trigger is the app's own — the library ships no widget. */}
      {!showInspector && (
        <Pressable
          onPress={() => setShowInspector(true)}
          accessibilityRole="button"
          accessibilityLabel="Open network logs"
          style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
        >
          <Text style={styles.fabIcon}>⇅</Text>
        </Pressable>
      )}

      <Modal
        visible={showInspector}
        animationType="slide"
        onRequestClose={() => setShowInspector(false)}
      >
        {/* Padding the wrapper, not the inspector: it fills whatever box it's
            given, so insets belong out here. The inspector never dismisses
            itself either — the close control is ours. On Android the hardware
            back button hits onRequestClose above. */}
        <View style={styles.inspectorWrap}>
          <HttpInspector />
          <Pressable
            onPress={() => setShowInspector(false)}
            style={({ pressed }) => [
              styles.close,
              pressed && styles.fabPressed,
            ]}
          >
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f6f6f8' },
  content: {
    padding: 20,
    paddingTop: TOP_INSET + 20,
    paddingBottom: BOTTOM_INSET + 120,
    gap: 10,
  },
  title: { fontSize: 26, fontWeight: '700', color: '#111' },
  subtitle: { fontSize: 14, color: '#666', marginBottom: 14, lineHeight: 20 },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e3e3e8',
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  buttonPressed: { opacity: 0.65 },
  buttonPrimary: {
    backgroundColor: '#4f39ef',
    borderColor: '#4f39ef',
    marginTop: 6,
  },
  buttonText: { fontSize: 15, color: '#111', fontWeight: '500' },
  buttonPrimaryText: { color: '#fff' },

  fab: {
    position: 'absolute',
    right: 20,
    // Absolute within the unpadded container, so it carries the inset itself.
    bottom: BOTTOM_INSET + 24,
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#4f39ef',
    elevation: 6,
    shadowColor: '#4f39ef',
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  fabPressed: { opacity: 0.8 },
  fabIcon: { color: '#fff', fontSize: 22, lineHeight: 26 },

  inspectorWrap: {
    flex: 1,
    paddingTop: TOP_INSET,
    paddingBottom: BOTTOM_INSET,
    // Matches the inspector's own background so the inset strips don't read as
    // gaps. The inspector defaults to its light palette.
    backgroundColor: '#fff',
  },
  close: {
    position: 'absolute',
    left: 20,
    // Sits inside the padded area, clear of the home indicator.
    bottom: BOTTOM_INSET + 16,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 22,
    backgroundColor: '#4f39ef',
  },
  closeText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});

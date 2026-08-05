# react-native-http-inspector

In-app network inspector for React Native. See every HTTP request your app makes —
status, timing, headers, and bodies — on the device, without a debugger attached.

Requests are captured by patching `XMLHttpRequest`, so `fetch`, `axios`, and
anything else built on XHR are all recorded with no per-call changes.

**iOS and Android.** Pure JavaScript — no native module, no linking, no pods of
its own — but it reads React Native's internal Blob and FormData shapes to
resolve bodies, so it isn't supported on `react-native-web`.

## What you get

- **Request list** — status pill, method, url, duration and response size, newest
  first. Filter by text, or by 2xx/3xx · 4xx/5xx · pending.
- **Request detail** — three tabs (Overview, Request, Response) with timing,
  headers, bodies, and a one-tap copy-as-cURL.
- **JSON tree** — collapsible, searchable viewer for JSON bodies. Renders a
  flattened row list through `FlatList`, so large payloads stay scrollable.
- **Programmatic access** — read or subscribe to the captured log yourself and
  build your own UI on top of it.
- **Light/dark palette**, toggled in-screen, independent of your app's theme.

Rows appear the moment a request starts and settle in place when it completes:
in-flight entries have no `status` or `duration`, and transport failures (DNS
failure, connection refused, timeout, abort) are recorded as a distinct `failure`
state rather than a misleading status `0`.

## Installation

```sh
npm install react-native-http-inspector
# or
yarn add react-native-http-inspector
```

No other dependencies — `react` and `react-native` are the only peers.

### Clipboard (optional)

Copy buttons need something that can write to the clipboard. The inspector finds
one on its own, in this order:

1. an `onCopy` you pass to `<HttpInspector>`
2. [`@react-native-clipboard/clipboard`](https://github.com/react-native-clipboard/clipboard),
   if your app already has it
3. `react-native`'s built-in `Clipboard` — deprecated, but still working today

If none are available the copy controls are hidden and everything else works.
To be explicit, or to hook into your own clipboard, pass `onCopy`:

```jsx
import Clipboard from '@react-native-clipboard/clipboard';

<HttpInspector onCopy={Clipboard.setString} />;
```

## Usage

### 1. Start capturing

Call `startNetworkLogging()` once, as early as possible — only traffic made
*after* this call is recorded. Module scope in your entry file works well:

```js
import { startNetworkLogging } from 'react-native-http-inspector';

startNetworkLogging();
```

### 2. Render the inspector

`HttpInspector` fills its container and needs no props. It's presentational: it
never navigates or dismisses itself, so **you** own how it opens and closes.

It only displays what the interceptor has captured — without step 1 it renders an
empty list, with no error to tell you why.

As a modal:

```jsx
import { useState } from 'react';
import { Button, Modal, View } from 'react-native';
import { HttpInspector } from 'react-native-http-inspector';

function DebugMenu() {
  const [open, setOpen] = useState(false);

  return (
    <View>
      <Button title="Network logs" onPress={() => setOpen(true)} />
      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={{ flex: 1 }}>
          <HttpInspector />
          <Button title="Close" onPress={() => setOpen(false)} />
        </View>
      </Modal>
    </View>
  );
}
```

Or as a navigator screen:

```jsx
<Stack.Screen name="NetworkLogs" component={HttpInspector} />
```

> **Provide a way out.** Since the inspector has no close button of its own,
> rendering it with no dismiss control and no navigator leaves users stuck.

### Safe areas

The inspector applies no safe-area padding — insets are yours to manage. Wrap it
if it needs to clear a notch or home indicator:

```jsx
<SafeAreaView style={{ flex: 1 }}>
  <HttpInspector />
</SafeAreaView>
```

## API

### `<HttpInspector />`

| Prop     | Type                     | Description                                                                     |
| -------- | ------------------------ | ------------------------------------------------------------------------------- |
| `onCopy` | `(text: string) => void` | Optional. Copies text to the clipboard. See [Clipboard](#clipboard-optional).    |

### `startNetworkLogging(options?)`

Patches `XMLHttpRequest` and begins recording. Calling it again while already
running is a no-op.

| Option            | Type       | Default | Description                                                      |
| ----------------- | ---------- | ------- | ---------------------------------------------------------------- |
| `maxRequests`     | `number`   | `500`   | Ring-buffer size. Oldest entries are evicted first.              |
| `ignoredHosts`    | `string[]` | —       | Hostnames to skip. Give them without a port — `'10.0.2.2'` matches `10.0.2.2:8081`. |
| `ignoredUrls`     | `string[]` | —       | Exact urls to skip.                                              |
| `ignoredPatterns` | `RegExp[]` | —       | Tested against `` `${method} ${url}` `` — note the url is absolute. |

Filtering out noisy traffic keeps the list readable — in development the RN dev
server's `/symbolicate` calls are the usual culprit:

```js
startNetworkLogging({
  maxRequests: 200,
  ignoredHosts: ['localhost', '10.0.2.2'],
  ignoredPatterns: [/^GET \S+\.(png|jpg|svg)/],
});
```

### `stopNetworkLogging()`

Restores the original `XMLHttpRequest` methods. Already-captured entries are kept.

### `getRequests(): NetworkLogEntry[]`

The captured log, newest first.

### `subscribeToNetworkLog(listener): () => void`

Calls `listener` whenever the log changes, and returns an unsubscribe function.
Notifications are coalesced, so a burst of parallel requests won't cause a
re-render per callback.

```js
useEffect(() => subscribeToNetworkLog(() => setRequests(getRequests())), []);
```

### `clearRequests()`

Empties the log.

### `NetworkLogEntry`

```ts
type NetworkLogEntry = {
  id: string;
  method: string;
  url: string;
  status?: number;         // undefined while in flight
  failure?: 'error' | 'timeout' | 'abort';  // set instead of status on transport failure
  startTime: number;
  endTime?: number;
  duration?: number;       // ms, only once complete; never negative
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody?: unknown;   // verbatim, as passed to send()
  response?: unknown;      // string, object, or Blob handle
  responseType?: string;
  responseURL?: string;
  responseContentType?: string;
  responseSize?: number;
  timeout?: number;
};
```

## Notes

**Development builds only.** The inspector holds request and response bodies —
including auth headers and tokens — in memory, and puts them on screen. Gate it
behind `__DEV__` or a staff-only flag rather than shipping it to users. It also
means any session-recording or screenshot tooling in your app can capture that
data while the screen is open. See [SECURITY.md](SECURITY.md) for the full
picture and how to report a vulnerability.

**Memory.** Entries are held in memory up to `maxRequests` (default 500), bodies
included. Lower it if your app moves large payloads.

**`fetch` is covered.** React Native implements `fetch` on top of
`XMLHttpRequest`, so patching XHR captures it too. Requests made from native code
or over WebSockets are not captured.

**Platforms.** Developed and tested against iOS and Android. The interceptor
itself is standard `XMLHttpRequest` patching, but body resolution depends on how
React Native represents blobs and `FormData` internally, and the UI leans on
RN-specific style props — so `react-native-web` is out of scope, and other
platforms (Windows, macOS, tvOS) are untested rather than deliberately excluded.

## Example

The [`example/`](example/) app fires a spread of requests — success, 404, 500,
transport failure, large payload, slow response — and opens the inspector over
them:

```sh
yarn install
yarn example ios     # or: yarn example android
```

## Contributing

- [Development workflow](CONTRIBUTING.md#development-workflow)
- [Sending a pull request](CONTRIBUTING.md#sending-a-pull-request)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)

## License

MIT

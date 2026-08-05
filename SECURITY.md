# Security Policy

## Supported versions

This package is pre-1.0. Security fixes land on the latest minor release only —
there are no long-term support branches yet.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |
| < 0.1   | ❌        |

## Reporting a vulnerability

**Please don't open a public issue for a security problem.**

Report it privately through
[GitHub Security Advisories](https://github.com/devAdrish/react-native-http-inspector/security/advisories/new),
or by email to dev.adrishs@gmail.com.

Useful things to include:

- what an attacker can do, and what access they need to do it
- affected versions
- a minimal reproduction, if you have one

You can expect an acknowledgement within a few days. This is a solo-maintained
project, so please allow reasonable time for a fix before disclosing publicly.

## What this package does with your data

Worth understanding before you decide how to use it, because the design has a
security consequence that isn't a bug:

**The inspector captures everything and displays it.** It patches
`XMLHttpRequest`, so it records every request the app makes — including
`Authorization` headers, cookies, session tokens, API keys, and full request and
response bodies. Captured entries are held in memory (up to `maxRequests`,
default 500) and rendered on screen in plain text.

That is the point of the tool, but it means:

- **Don't ship it enabled in production builds.** Gate `startNetworkLogging()`
  behind `__DEV__` or an internal-only flag. If the inspector is reachable by an
  end user, so are their tokens.
- **Screen-capture tooling sees it too.** Session recording, crash-reporter
  screenshots, and analytics replay will capture the inspector's contents while
  it's open, potentially shipping secrets to a third party.
- **Filter what you don't want recorded.** `ignoredHosts`, `ignoredUrls`, and
  `ignoredPatterns` on `startNetworkLogging()` skip matching traffic entirely, so
  it's never stored.

Nothing is written to disk, and nothing is transmitted anywhere — captured data
lives only in memory for the process lifetime and is dropped on
`clearRequests()`, on eviction past `maxRequests`, or when the app exits.

## Scope

In scope: anything that lets captured data escape the app, that lets a third
party influence what the interceptor records, or that breaks the ignore lists.

Out of scope: the inspector displaying secrets to someone who can already open
it — that is inherent to what it does, and the mitigation is not shipping it to
end users.

# Web, Electron, and IDE UI recipe

Adapted from cursor-team-kit `control-ui` (MIT). Use it to fill in the Drive and Evidence sections for a browser-rendered surface.

## Choose the harness

1. Reuse the repository's own browser tooling first: end-to-end specs, Storybook, browser scripts, Electron launch scripts.
2. Otherwise drive the app with whatever browser automation is already installed (a Playwright dependency, or a browser tool the harness provides). Do not add a browser dependency to the project just for verification unless the user agrees.
3. For Electron or a Chromium app, launch with `--remote-debugging-port=<port>` and connect over the Chrome DevTools Protocol (CDP).

## Select the right page

Several windows can share one debug port. Select the page by a positive app marker, such as a root element, landmark, or product `data-*` attribute, not by tab order. Use a negative marker to exclude the wrong surface when needed. If no page matches, list each page's title and URL and stop; never guess.

```javascript
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
const pages = browser.contexts().flatMap((context) => context.pages());
const matches = [];
for (const candidate of pages) {
  if (await candidate.locator(APP_ROOT_SELECTOR).count()) matches.push(candidate);
}
if (matches.length !== 1) {
  console.error(await Promise.all(pages.map(async (p) => ({ title: await p.title(), url: p.url() }))));
  throw new Error(`expected one app page, found ${matches.length}`);
}
```

## Interaction loop

1. Capture an accessibility snapshot or screenshot before acting.
2. Choose the target from that latest snapshot, by role and accessible name where possible.
3. Perform exactly one action: click, type, key press, drag, scroll, navigate, or resize.
4. Wait for a concrete state (an element, a status, a network response), not a fixed sleep.
5. Capture a fresh snapshot and check the expected change.

Re-query elements after navigation or any structural change. Click by coordinates only right after a fresh screenshot, and only when no stable handle exists.

## Evidence

- An accessibility snapshot plus a screenshot with the app identity visible, for each proved state.
- Console errors and failed network requests during the drive.
- A second, read-only view of any mutation (reload, reopen, or query the API).
- For performance claims: a trace or CPU profile, with the same scenario run before and after.

Raw CDP is for what higher-level APIs cannot do: CPU profiles and traces, heap snapshots with forced GC, request blocking and throttling, emulation (viewport, color scheme, reduced motion), and console or exception streaming.

## Guardrails

- Keep test data local and disposable; use a fresh browser profile per run.
- Do not save screenshots or heap snapshots from privacy-sensitive workspaces without the user's agreement.
- Discover selectors, ports, and scripts from this repository; never copy them from another one.
- Cleanup stops the dev server, browser, and debug session this run started, and removes temporary profiles, not evidence.

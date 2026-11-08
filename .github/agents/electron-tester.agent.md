---
name: electron-tester
description: Test the running Electron app through its renderer DevTools connection, exercise key pages, and save an HTML report or screenshots under the ignored test-artifacts folder.
argument-hint: Describe the Electron app flow or pages to test, for example: "test Home, Downloads, Library, and Profile and capture evidence".
---

# Electron tester

Use this agent for manual smoke tests of the running Electron application.

## Responsibilities

- Discover the Electron renderer's Chrome DevTools Protocol port.
- Attach to the page target and inspect the accessibility tree before interacting.
- Exercise the requested navigation and user flows using accessible names where possible.
- Check for page-load failures, console errors, failed network requests, and visible error states.
- Capture screenshots for important states, or create an HTML report when screenshots are unavailable.
- Write all generated evidence to `test-artifacts/`; never commit that folder.
- Report the tested URL, flows, evidence paths, and any failures clearly.

## Operating procedure

1. Start the app with a renderer remote debugging port, such as `9222`; the Node inspector port (for example `5858`) is not sufficient for screenshots.
2. Discover and attach to the renderer target.
3. Record the initial page information and accessibility snapshot.
4. Test each requested page or flow, waiting for navigation/content to settle.
5. Save screenshots or an HTML report in `test-artifacts/`.
6. Review console and network failures, then summarize the result.

Prefer non-destructive smoke tests. Do not delete application data, submit external forms, or download untrusted content unless the user explicitly requests it.

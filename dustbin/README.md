# Dustbin

This directory archives adapter experiments that are not part of the current
supported runtime path. It is intentionally outside the npm package `files`
list and is not covered by the active adapter test suite.

Archived content includes:

- the SWE-agent adapter;
- the legacy OpenHands explicit runner and App Server request-injection flow;
- an OpenHands plugin draft that is not loaded by the supported CLI version;
- superseded adapter analysis and submission notes.

The maintained integration is `src/adapters/openhands`: OpenHands CLI/TUI
lifecycle hooks provide automatic recall and capture, while MCP exposes active
memory search. Files in this directory are retained only as implementation
history and should not be presented as supported entry points.

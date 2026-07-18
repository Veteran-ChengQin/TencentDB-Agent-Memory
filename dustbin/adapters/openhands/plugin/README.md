# TencentDB Agent Memory Plugin for OpenHands

This bundle packages the OpenHands lifecycle hooks, MCP search server, and
memory-search skill. The Python adapter must be importable and the TDAI Gateway
must be running.

Current OpenHands releases can load it with:

```bash
openhands --plugin /path/to/TencentDB-Agent-Memory/src/adapters/openhands/plugin
```

For OpenHands CLI versions that do not expose `--plugin`, use the adapter
launcher. It safely materializes the same hooks and MCP configuration before
starting the TUI:

```bash
python -m tdai_openhands.launcher \
  --launcher-config /path/to/tdai-openhands-launcher.yaml \
  tui
```

# TDAI Search Tool Bundle for SWE-agent

This optional SWE-agent tool bundle exposes TencentDB Agent Memory search
commands inside the SWE-bench execution environment.

Commands:

- `tdai_memory_search <query> [limit]`: searches L1 structured memories.
- `tdai_conversation_search <query> [limit]`: searches L0 raw conversations.

The tools call the TDAI Gateway over HTTP. Configure these environment
variables through the SWE-agent adapter:

- `TDAI_GATEWAY_URL`: Gateway URL reachable from inside the container.
- `TDAI_GATEWAY_API_KEY_ENV`: name of the environment variable containing the
  Gateway bearer token.
- `TDAI_GATEWAY_API_KEY`: optional Gateway bearer token.
- `TDAI_SESSION_KEY`: optional session key used by conversation search.

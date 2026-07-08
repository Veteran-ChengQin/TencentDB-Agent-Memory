/**
 * TDAI Adapters - barrel re-export for host adapter implementations.
 *
 * Each adapter translates a specific host environment's API into
 * the host-neutral HostAdapter interface consumed by TdaiCore.
 *
 * Directory structure:
 *   adapters/
 *   - openclaw/      OpenClaw plugin host (in-process, runEmbeddedPiAgent)
 *   - standalone/    Gateway / Hermes sidecar (HTTP, OpenAI-compatible API)
 *   - swe-agent/     Python integration for SWE-agent. This is packaged as an
 *                    external adapter resource and is not exported from this
 *                    TypeScript barrel.
 *   - openhands/     Python integration for OpenHands. This is packaged as an
 *                    external adapter resource and is not exported from this
 *                    TypeScript barrel.
 */

// OpenClaw adapter
export { OpenClawHostAdapter, OpenClawLLMRunner, OpenClawLLMRunnerFactory } from "./openclaw/index.js";
export type { OpenClawHostAdapterOptions, OpenClawLLMRunnerFactoryOptions } from "./openclaw/index.js";

// Standalone adapter
export { StandaloneHostAdapter, StandaloneLLMRunner, StandaloneLLMRunnerFactory } from "./standalone/index.js";
export type { StandaloneHostAdapterOptions, StandaloneLLMConfig, StandaloneLLMRunnerFactoryOptions } from "./standalone/index.js";

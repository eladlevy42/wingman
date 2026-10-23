# Use the plain Anthropic Messages API, not a coding-agent SDK, for Barney

> **Superseded by [0011](0011-migrate-to-claude-agent-sdk.md).** OAuth-subscription auth for dev/local runs was judged worth more than avoiding the Agent SDK's larger surface area; BarneyAgent, NegotiationAgent, and softTurn were migrated onto `@anthropic-ai/claude-agent-sdk`. The historical reasoning below is preserved as-is.

## Context

CLAUDE.md names `@anthropic-ai/agent-sdk` as the AI core, but no such package exists, and nothing in the codebase has used any Anthropic package yet — issue #16 is the first integration point. The two real candidates are `@anthropic-ai/sdk` (the Messages API, with manual tool-use) and `@anthropic-ai/claude-agent-sdk` (the Claude Code coding-agent harness, built for filesystem/bash-driven autonomous tasks).

## Decision

`BarneyAgent` uses `@anthropic-ai/sdk` with manually-defined tool schemas (`saveProfile`, `saveWantedProfile`, etc.) and a hand-rolled message loop. The Claude Agent SDK's autonomous coding-agent machinery (file access, bash, long-horizon task execution) has no role in a conversational interview bot with one or two custom tools.

## Consequences

Any future CLAUDE.md reference to "Agent SDK" means this manual Messages-API integration, not the Claude Agent SDK package. `pnpm add @anthropic-ai/sdk` in `apps/api`, not `@anthropic-ai/agent-sdk` (doesn't exist) or `@anthropic-ai/claude-agent-sdk` (wrong tool for this job).

`BarneyAgent` also holds conversation history purely in server memory for the lifetime of a session — it makes no database calls itself. There is no `Session` table; nothing persists until the agent's tool (e.g. `saveProfile`) fires. A server restart mid-interview loses that session's history, which is an acceptable POC trade-off, not a durability guarantee.

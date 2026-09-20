# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private vulnerability reporting for this repository (*Security → Report a vulnerability*). Include what you found, how to reproduce it, and the impact you expect. You can expect an acknowledgement within a few days.

## Supported versions

Only the latest release receives security fixes.

## Threat model in brief

What the project defends against, and what it deliberately does not:

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| **Prompt injection** via synced text (repository names, page titles) reaching the model | Tools are read-only against a local snapshot; the system prompt frames tool output as data, not instructions; an eval regression-tests a hijack attempt | Reduced, not eliminated — a model can still be influenced by adversarial text. Treat agent output as untrusted. |
| **Credential exfiltration** through a malicious pagination link | The GitHub adapter refuses to follow a link to a different origin than the configured API | None known for GitHub. Notion pagination uses a body cursor, not a URL. |
| **Model-produced arguments** | Validated against the tool's schema before execution; oversized tool output is truncated | — |
| **Secrets in logs or tests** | Tokens are read only inside the functions that use them and never logged; `.env` is loaded only by the entry points (enforced by a test) | Verbose upstream error bodies are truncated to 200 characters in error messages. |
| **Stale or tampered local store** | Tools report `lastSyncAt`; the store is a local file protected by OS permissions | Anyone with access to `data.db` can alter what the agent sees. |

## Hardening notes

- Use read-only credentials with the narrowest scope that works.
- The Docker image runs as a non-root user; keep `/data` on a volume only that user can write.
- The MCP server speaks stdio only — it opens no network port.

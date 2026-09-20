# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private vulnerability reporting for this repository (*Security → Report a vulnerability*). Include what you found, how to reproduce it, and the impact you expect. You can expect an acknowledgement within a few days.

## Supported versions

Only the latest release receives security fixes.

## Threat model in brief

What the project defends against, and what it deliberately does not:

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| **Prompt injection** via synced text (repository names, page titles and bodies) reaching the model | Tools are read-only against a local snapshot; the system prompt frames tool output as data, not instructions; the tool descriptions say page text is untrusted; evals regression-test a hijack attempt in a title and in a page body | Reduced, not eliminated — a model can still be influenced by adversarial text. Treat agent output as untrusted. |
| **Credential exfiltration** through a malicious pagination link | The GitHub adapter refuses to follow a link to a different origin than the configured API | None known for GitHub. Notion pagination uses a body cursor, not a URL. |
| **Unauthorized remote access** to the HTTP MCP server | Fails closed without a token of at least 24 characters; the token is env-only, compared in constant time before the body is read; `Host` and `Origin` are validated (DNS rebinding); binds to loopback by default; POST-only, stateless, body-size capped | Plain HTTP: a bearer token is readable on the network, so non-loopback deployments need a TLS-terminating proxy. The shared token is one identity for everyone who holds it: use OAuth to tell clients apart. |
| **A stolen, leaked or over-broad OAuth access token** | Tokens must be signed by the configured issuer with an asymmetric algorithm (`none` and `HS*` are refused), unexpired, issued for this server's audience (RFC 8707) and carry the required scope; a local deny-list (`auth revoke`) cuts off a client, a user or a single token immediately; each client is rate-limited; the authorization server and key-set URLs must be `https://` | A leaked token works until it expires or is revoked, so keep lifetimes short. The deny-list is only as good as the identifiers the tokens carry (`client_id`, `sub`, `jti`). Requests that fail authentication are not rate-limited here — do that at the reverse proxy. |
| **Model-produced arguments** | Validated against the tool's schema before execution; oversized tool output is truncated | — |
| **Private data or credentials leaking into traces** | Prompts, answers and tool output are never recorded; URLs are recorded without their query string; API keys never appear (a test asserts all three); export happens only when an endpoint is configured | Span and metric attributes such as repository counts, host names and model names are still sent to your collector. Use a collector you trust. |
| **Secrets in logs or tests** | Tokens are read only inside the functions that use them and never logged; `.env` is loaded only by the entry points (enforced by a test) | Verbose upstream error bodies are truncated to 200 characters in error messages. |
| **Stale or tampered local store** | Tools report `lastSyncAt`; the store is a local file protected by OS permissions | Anyone with access to `data.db` can alter what the agent sees. |

## Hardening notes

- Use read-only credentials with the narrowest scope that works.
- The Docker image runs as a non-root user; keep `/data` on a volume only that user can write.
- The MCP server speaks stdio only — it opens no network port.

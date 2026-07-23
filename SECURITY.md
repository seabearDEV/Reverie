# Security Policy

## Supported Versions

Only the latest minor release receives security updates. Install channels are
GitHub release binaries and Homebrew (`seabearDEV/homebrew-reverie`) — Reverie
is **not published to npm**; the `@seabear/reverie` name is a squatting
reservation only.

| Version | Supported          |
| ------- | ------------------ |
| 1.3.x   | :white_check_mark: |
| < 1.3   | :x:                |

## Reporting a Vulnerability

Please report security vulnerabilities through [GitHub's private security advisory feature](https://github.com/seabearDEV/reverie/security/advisories/new).

**Do not open a public issue for security vulnerabilities.**

### What to expect

- **Acknowledgment** within 48 hours of your report.
- **Status update** within 7 days with an initial assessment.
- If accepted, a fix will be released as a patch to the latest minor version.
- If declined, you'll receive an explanation of why the report doesn't qualify.

### Scope

The following are in scope:

- Command injection via stored entries or interpolation
- **Hostile store content**: `.reverie/` directories ship inside cloned
  repositories and entries are agent-trusted instructions — entries that
  achieve code execution on *read*, bypass confirmation gates, or persist
  prompt injection are exactly the class we most want to hear about
  (prior art: GHSA-hf25-j9h5-5vq5, the v1.2.1 exec-on-read RCE)
- Path traversal in file operations
- Credential or sensitive data exposure (e.g., encrypted values leaking in logs, audit, or telemetry)
- MCP server vulnerabilities that could be exploited by a malicious client

Out of scope:

- Vulnerabilities in upstream dependencies (report these to the relevant maintainer)
- Issues requiring physical access to the machine
- Social engineering

## Detection and response

Detection is scheduled — Dependabot alerts, a weekly `bun audit` cron, CodeQL,
and an agentic adversarial audit before every minor release
(docs/security/release-process.md). Patching is event-driven:

- **Critical / high** → out-of-band patch release immediately.
- **Moderate / low** → folded into the next themed minor release.

Every confirmed vulnerability gets a regression test encoding the exploit, so
a future refactor that re-opens it fails CI.

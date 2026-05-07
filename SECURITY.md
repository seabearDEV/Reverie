# Security Policy

## Supported Versions

Only the latest minor release receives security updates.

| Version | Supported          |
| ------- | ------------------ |
| 1.6.x   | :white_check_mark: |
| < 1.6   | :x:                |

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
- Path traversal in file operations
- Credential or sensitive data exposure (e.g., encrypted values leaking in logs, audit, or telemetry)
- MCP server vulnerabilities that could be exploited by a malicious client

Out of scope:

- Vulnerabilities in upstream dependencies (report these to the relevant maintainer)
- Issues requiring physical access to the machine
- Social engineering

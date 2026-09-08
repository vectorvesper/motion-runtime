# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 2.x | Yes |
| 1.x | No — please upgrade |
| 0.x | No |

## Reporting a vulnerability

Email **support@vectorvesper.dev**. Please do not open a public issue for a
security report.

Include what you found, how to reproduce it, and the version. You will get an
acknowledgement within 72 hours and an assessment within a week.

## Scope

This package runs entirely in the browser, has no network access, and reads no
credentials. Realistic reports are things like a supply-chain problem in the
published tarball, a prototype-pollution path through an options object, or a
denial-of-service reachable from untrusted input.

The published tarball contains only built output — no sourcemaps, no source. If
you find source or a secret inside it, that is a reportable problem in itself.

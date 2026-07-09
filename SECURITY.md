# Security Policy

`hx-fortress` runs on customer infrastructure and handles enrollment tokens, an
Ed25519 signing key, storage credentials, and AI session transcripts. We take
security reports seriously and appreciate responsible disclosure.

## Supported Versions

Only the latest released version receives security fixes. This project is
pre-1.0; the current supported line is `0.11.x`.

| Version        | Supported          |
| -------------- | ------------------ |
| latest release | :white_check_mark: |
| older releases | :x:                |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately through either channel:

- **Preferred:** GitHub Private Vulnerability Reporting — the "Report a
  vulnerability" button under this repository's **Security** tab.
- **Email:** [security@<domain>] (PGP key: [link/fingerprint]).

Please include: affected version/commit, a description and impact assessment,
and reproduction steps or a proof-of-concept where possible. Findings against
the enrollment, signing-key, capability-token, self-update, or storage-
credential paths are prioritized.

## Response Targets

| Stage                              | Target                  |
| ---------------------------------- | ----------------------- |
| Acknowledge receipt                | within 2 business days  |
| Initial assessment / triage        | within 7 days           |
| Fix or coordinated-disclosure plan | within 90 days          |

Timelines may be adjusted for complex issues by mutual agreement.

## Scope

In scope: this repository's source and released binaries. Out of scope:
third-party dependencies (report upstream), social engineering, and physical
attacks. The wire-protocol types live in `hx-protocol`; the client daemon in
`hx`.

## Safe Harbor

We will not pursue legal action against researchers who act in good faith,
avoid privacy violations and service disruption, and give us a reasonable
opportunity to remediate before public disclosure.

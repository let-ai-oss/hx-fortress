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

## Known residuals

These are properties of the design, not open bugs. They are stated here so an
operator can decide about them rather than discover them.

### Console containment is EMBEDDED-Postgres only

With the bundled Postgres, the console command queue (`hx.console_commands`) is
a one-way state machine: the daemon's write role — the role reachable through
the cloud tunnel — holds no INSERT and no UPDATE on the table, and every
transition runs through a `SECURITY DEFINER` routine owned by a NOLOGIN role
that holds nothing else. The same split keeps that role out of `hx.admin_audit`,
so it cannot forge or amend an audit record.

Against an **external Postgres** (`FORTRESS_DATABASE_URL`) both of those are
**void**. There is no role split to enforce, the operator's role OWNS the tables
— an owner cannot be constrained by `REVOKE` and bypasses any routine with plain
DML — and the apparatus is never created there at all. Console mutations still
work; they are simply not contained.

Remediation: run the daemon under a NON-OWNING role.
`hx-fortress ui config --print-role-sql` emits that script — table DML only,
`SELECT, UPDATE` on the command queue and never `INSERT`, so minting stays with
the console role the same script creates.

### Command outcomes are corroborated, not trusted

The daemon's Postgres authority IS the write role, so an adversary holding it
can call the completion routines directly and report an outcome for work that
never ran. No SQL-layer fix exists: any nonce the routine could check is one the
same role could rotate. The daemon therefore writes every transition it actually
performs to a 0600 file that role cannot reach, drained into the audit table by
the console role, and the console renders a terminal outcome as REPORTED
(unconfirmed) until a matching record corroborates it.

### The console process holds a bucket-write-capable key

The fortress has ONE storage credential for both reads and writes, and signing
the console's `HEAD`/`LIST`/`GetBucketVersioning` calls requires exactly the
secret half of it. The console is given the storage block minus the OpenAI key;
the storage credential it does hold can also write.

### A downgrade window is not audit-trustworthy

The console-table `REVOKE`s are carried both by the migration and by every boot.
An OLDER binary re-grants the write role full DML on its first boot through its
blanket schema grant, so audit rows written while a downgraded binary was
running are untrusted.

## Safe Harbor

We will not pursue legal action against researchers who act in good faith,
avoid privacy violations and service disruption, and give us a reasonable
opportunity to remediate before public disclosure.

import { describe, expect, test } from "bun:test";

import { scrubSecrets } from "../src/modules/embed-worker/scrub";
import { hxSemanticSearch } from "../src/query/semantic-search";
import type { HxDb } from "../src/host/postgres/db";
import type { Embedder } from "../src/modules/embed-worker/openai";

// H-7 · the per-turn / per-query secret + PII scrub that sanitizes conversational
// text BEFORE it egresses to OpenAI for embedding. These run with no DB and no
// network — pure redaction logic.

describe("scrubSecrets — new secret/PII shapes (H-7)", () => {
  test.each([
    ["Stripe secret key (underscore form)", "key sk_live_abcdEFGH1234567890 here"],
    ["Stripe restricted key", "rk_test_abcdEFGH1234567890"],
    ["Stripe webhook secret", "whsec_abcdEFGH1234567890"],
    ["GitHub fine-grained PAT", "github_pat_11ABCDEFG0abcdefghijKLMNOP"],
    ["Postgres DSN with credentials", "postgres://user:s3cr3t@db.internal:5432/app"],
    ["mongodb+srv DSN", "mongodb+srv://admin:pw@cluster0.example.net/db"],
    ["email address", "reach me at alice.doe@example.co.uk please"],
    ["US SSN", "ssn 123-45-6789 on file"],
    ["phone number", "call +1 415-555-0123 today"],
    ["AWS 40-char secret", `secret ${"A".repeat(40)} end`],
  ])("redacts %s", (_name, input) => {
    const out = scrubSecrets(input);
    expect(out).toContain("[REDACTED]");
    // The distinctive secret token must be gone.
    expect(out).not.toMatch(/sk_live_abcd|rk_test_abcd|whsec_abcd|github_pat_11|s3cr3t|alice\.doe|123-45-6789|415-555-0123/);
  });

  test("redacts a Luhn-valid credit card but preserves a non-card long number", () => {
    expect(scrubSecrets("card 4111 1111 1111 1111 on file")).toContain("[REDACTED]");
    expect(scrubSecrets("card 4111 1111 1111 1111 on file")).not.toContain("4111");
    // Same shape but fails Luhn ⇒ left intact (it is not a card).
    const notCard = scrubSecrets("order 4111111111111112 shipped");
    expect(notCard).toContain("4111111111111112");
  });

  test("preserves ordinary prose untouched", () => {
    const prose = "The quick brown fox jumped over the lazy dog near the riverbank.";
    expect(scrubSecrets(prose)).toBe(prose);
  });

  test("completes fast on a 100 KB adversarial string (ReDoS guard)", () => {
    // ~100 KB of card-like tokens with boundaries — the worst case for the Luhn
    // card pass and the boundaried patterns. A ReDoS would blow the time budget.
    const adversarial = "4111111111111111 ".repeat(6000);
    expect(adversarial.length).toBeGreaterThan(100_000);
    const started = performance.now();
    const out = scrubSecrets(adversarial);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(2000);
    expect(out).toContain("[REDACTED]");
  });
});

describe("hxSemanticSearch — query text is scrubbed before egress (H-7)", () => {
  test("the embedder only ever sees a redacted query", async () => {
    let seen: string | undefined;
    const embedder: Embedder = {
      model: "text-embedding-3-large",
      dimensions: 4,
      async embed(texts) {
        seen = texts[0];
        return [[0.1, 0.2, 0.3, 0.4]];
      },
    };
    // Minimal fake db: vector "available", and a transaction that yields no rows
    // (the query embed — the only thing under test — already happened by then).
    const db = {
      execute: async () => [{ ok: true }],
      transaction: async () => [],
    } as unknown as HxDb;

    const result = await hxSemanticSearch(db, embedder, {
      scope: { identities: [{ userExternalId: "u", family: "f", sessionId: "s" }] },
      queryText: "find where my key sk_live_abcdEFGH1234567890 leaked",
    });

    expect(result.unavailable).toBeUndefined();
    expect(seen).toBeDefined();
    expect(seen).toContain("[REDACTED]");
    expect(seen).not.toContain("sk_live_abcdEFGH1234567890");
  });
});

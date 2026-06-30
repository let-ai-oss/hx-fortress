// A3 · the OpenAI embedding client. Fetch-based (no SDK dependency) so it
// compiles cleanly into the `bun build --compile` binary — the only network
// surface is `fetch`, already in the Bun runtime. Calls the embeddings endpoint
// with `text-embedding-3-large` @ `dimensions:1024` (Matryoshka — the native
// width is 3072, so the param is REQUIRED or a 3072-vector would overflow the
// vector(1024) column). Retries 429 / 5xx with capped exponential backoff.

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  /** Embed a batch of texts; returns vectors in input order. */
  embed(texts: string[]): Promise<number[][]>;
}

export interface OpenAIEmbedderOptions {
  apiKey: string;
  model?: string;
  dimensions?: number;
  /** Endpoint base (override for a zero-retention / DPA OpenAI endpoint). */
  baseUrl?: string;
  /** Hard char cap per input — a coarse guard under the model's token cap so a
   *  pathological turn can't blow the request. Conversational turns are tiny. */
  maxChars?: number;
  maxRetries?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export const DEFAULT_EMBED_MODEL = "text-embedding-3-large";
export const DEFAULT_EMBED_DIMENSIONS = 1024;
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MAX_CHARS = 32_000;
const DEFAULT_MAX_RETRIES = 4;

interface EmbeddingResponse {
  data: Array<{ index: number; embedding: number[] }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build an OpenAI-backed embedder. Throws on a non-retryable API error. */
export function createOpenAIEmbedder(options: OpenAIEmbedderOptions): Embedder {
  const model = options.model ?? DEFAULT_EMBED_MODEL;
  const dimensions = options.dimensions ?? DEFAULT_EMBED_DIMENSIONS;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const doFetch = options.fetchImpl ?? fetch;

  async function embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const input = texts.map((t) => (t.length > maxChars ? t.slice(0, maxChars) : t));

    let attempt = 0;
    for (;;) {
      const res = await doFetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({ model, input, dimensions }),
      });

      if (res.ok) {
        const json = (await res.json()) as EmbeddingResponse;
        // The API may not preserve order under retries — sort by `index`.
        const ordered = [...json.data].sort((a, b) => a.index - b.index);
        return ordered.map((d) => d.embedding);
      }

      const detail = await res.text().catch(() => "");
      // A 429 from an unfunded account (`insufficient_quota`) is NOT transient —
      // retrying just stalls; fail fast so the cause is obvious. Real rate limits
      // (and 5xx) stay retryable with backoff.
      const quotaExhausted = res.status === 429 && /insufficient_quota/.test(detail);
      const retryable = !quotaExhausted && (res.status === 429 || res.status >= 500);
      if (!retryable || attempt >= maxRetries) {
        // The error body is OpenAI's own JSON (never the key); truncate anyway.
        throw new Error(`openai embeddings ${res.status}: ${detail.slice(0, 200)}`);
      }
      const backoff = Math.min(1000 * 2 ** attempt, 8000);
      await sleep(backoff);
      attempt += 1;
    }
  }

  return { model, dimensions, embed };
}

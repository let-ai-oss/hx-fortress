import { describe, expect, test } from "bun:test";

import { assertS3EndpointSafe } from "../src/modules/session-vault/store/endpoint-safety";

// M-4 · a self-hosted vault's custom S3 endpoint must be https and must not aim
// at a loopback / link-local / private-range IP literal, unless the operator
// explicitly opts in. An optional host allowlist narrows further.

describe("assertS3EndpointSafe", () => {
  test("no custom endpoint is a no-op", () => {
    expect(() => assertS3EndpointSafe(undefined, {})).not.toThrow();
    expect(() => assertS3EndpointSafe("", {})).not.toThrow();
  });

  test("rejects a plaintext endpoint at the cloud-metadata address", () => {
    expect(() => assertS3EndpointSafe("http://169.254.169.254", {})).toThrow(
      /must use https/,
    );
  });

  test("rejects an https endpoint at a private-range IP literal", () => {
    expect(() => assertS3EndpointSafe("https://10.0.0.5", {})).toThrow(
      /private\/loopback address/,
    );
  });

  test("rejects the link-local metadata IP even over https", () => {
    expect(() => assertS3EndpointSafe("https://169.254.169.254", {})).toThrow(
      /private\/loopback address/,
    );
  });

  test("rejects a host that is not in the allowlist", () => {
    expect(() =>
      assertS3EndpointSafe("https://minio.other.example", {
        FORTRESS_S3_ENDPOINT_ALLOWLIST: "minio.corp.example, s3.corp.example",
      }),
    ).toThrow(/not in FORTRESS_S3_ENDPOINT_ALLOWLIST/);
  });

  test("accepts an allowlisted host", () => {
    expect(() =>
      assertS3EndpointSafe("https://minio.corp.example", {
        FORTRESS_S3_ENDPOINT_ALLOWLIST: "minio.corp.example",
      }),
    ).not.toThrow();
  });

  test("accepts a real https endpoint", () => {
    expect(() => assertS3EndpointSafe("https://s3.us-east-1.amazonaws.com", {})).not.toThrow();
  });

  test("opt-out allows a private https endpoint (private MinIO)", () => {
    expect(() =>
      assertS3EndpointSafe("https://10.0.0.5", { FORTRESS_S3_ALLOW_PRIVATE_ENDPOINT: "1" }),
    ).not.toThrow();
  });

  test("opt-out allows a plaintext private endpoint", () => {
    expect(() =>
      assertS3EndpointSafe("http://192.168.1.10:9000", { FORTRESS_S3_ALLOW_PRIVATE_ENDPOINT: "true" }),
    ).not.toThrow();
  });
});

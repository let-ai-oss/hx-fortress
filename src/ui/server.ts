// The console's HTTP surface: a pure request handler plus a thin Bun.serve
// shell. Everything stateful rides in a context object, so the handler is
// unit-testable with plain Request values.
//
// Everything served here is data-free by construction — the app shell, its
// content-hashed assets, and a bare liveness probe. Nothing is authenticated
// because nothing here is private, and nothing here discloses the fortress
// either: no version, no org, no configuration. A peer that reaches the port
// before signing in learns that a console is listening and nothing else.
//
//   GET  /            → index.html
//   GET  /<view>      → index.html   (the app owns its routes; a cold deep link
//                                     must land where it says)
//   GET  /assets/*    → embedded static files
//   GET  /fonts/*     → embedded static files
//   GET  /healthz     → 200, empty    (platform health checks)
//   /ui/api/*         → 404 until a route claims it — an API namespace must
//                       never answer a fetch with the HTML shell

import type { Server } from "bun";
import { contentTypeFor, type UiAssets } from "./assets";

export interface UiServerCtx {
  assets: UiAssets;
  /** The bound port — echoed nowhere, held for the checks that arrive with auth. */
  port: number;
}

// script-src carries exact hashes of any inline script in the shell instead of
// 'unsafe-inline'; style-src keeps 'unsafe-inline' for React style attributes —
// standard, and styles cannot exfiltrate. form-action 'none' is safe because the
// app posts with fetch and never navigates a form.
export function cspFor(inlineScriptHashes: string[]): string {
  const scriptSrc = ["'self'", ...inlineScriptHashes].join(" ");
  return (
    `default-src 'self'; script-src ${scriptSrc}; ` +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self'; font-src 'self'; base-uri 'none'; " +
    "frame-ancestors 'none'; form-action 'none'"
  );
}

function finish(res: Response, cache: string, csp: string): Response {
  res.headers.set("content-security-policy", csp);
  res.headers.set("x-content-type-options", "nosniff");
  res.headers.set("referrer-policy", "no-referrer");
  res.headers.set("cache-control", cache);
  return res;
}

/** Content-hashed names may be cached forever; the shell that names them may not. */
export function cacheControlFor(assetPath: string): string {
  if (assetPath === "/index.html") return "no-cache";
  if (assetPath.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  return "public, max-age=3600";
}

/** The request target as it arrived, before URL parsing normalizes `..` away.
 *  Bun resolves dot segments itself, so this is a belt for anything that hands
 *  the handler a target it did not resolve. */
export function rawRequestPath(requestUrl: string): string {
  const afterScheme = requestUrl.indexOf("://");
  const authorityStart = afterScheme < 0 ? 0 : afterScheme + 3;
  const pathStart = requestUrl.indexOf("/", authorityStart);
  if (pathStart < 0) return "/";
  const end = requestUrl.slice(pathStart).search(/[?#]/);
  return end < 0 ? requestUrl.slice(pathStart) : requestUrl.slice(pathStart, pathStart + end);
}

/**
 * True for a path that must 404 rather than fall through to the shell.
 *
 * Traversal cannot READ anything — the lookup is a map, never a path join — but
 * answering `/../../etc/passwd` with a 200 shell would still tell a scanner the
 * traversal was accepted, and would hide a genuinely missing asset behind an
 * HTML page the browser then fails to parse as JS. Checked against the raw
 * target as well as the parsed pathname: dot segments are resolved before the
 * handler runs, so what still arrives are the ENCODED shapes that survive
 * normalization (%2f, %5c, malformed escapes) — those must not be decoded into
 * a lookup key. Nothing here is what makes traversal impossible; the map is.
 */
export function isTraversal(pathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true; // malformed escapes are never a route
  }
  if (!decoded.startsWith("/") || decoded.includes("\\") || decoded.includes("\0")) return true;
  return decoded.split("/").some((seg) => seg === "." || seg === "..");
}

/** A request for a file, not for a view: it must 404 when the file is missing. */
export function looksLikeAsset(pathname: string): boolean {
  if (pathname.startsWith("/assets/") || pathname.startsWith("/fonts/")) return true;
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return last.includes(".");
}

/** Reserved for the console's own API; never served from the asset map. */
const API_PREFIX = "/ui/api/";

export function handleUiRequest(req: Request, ctx: UiServerCtx): Response {
  const url = new URL(req.url);
  const path = url.pathname;
  const csp = cspFor(ctx.assets.inlineScriptHashes);

  if (isTraversal(rawRequestPath(req.url)) || isTraversal(path)) {
    return finish(new Response("Not found", { status: 404 }), "no-store", csp);
  }

  if (path === "/healthz") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return finish(new Response(null, { status: 405 }), "no-store", csp);
    }
    // Read by the workbench interstitial before it navigates the owner here, so
    // the status must be readable cross-origin. The body is empty and the route
    // is already public, so a readable 200 discloses nothing an opaque timing
    // probe would not.
    const res = finish(new Response(null, { status: 200 }), "no-store", csp);
    res.headers.set("access-control-allow-origin", "*");
    return res;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return finish(new Response("Method not allowed", { status: 405 }), "no-store", csp);
  }

  // Map lookup only — a request path is never joined onto the filesystem, and
  // every key starts with "/" so it cannot reach Object.prototype either.
  const assetPath = path === "/" ? "/index.html" : path;
  const filePath = Object.hasOwn(ctx.assets.files, assetPath)
    ? ctx.assets.files[assetPath]
    : undefined;
  if (filePath) {
    return finish(
      new Response(Bun.file(filePath), {
        headers: { "content-type": contentTypeFor(assetPath) },
      }),
      cacheControlFor(assetPath),
      csp,
    );
  }

  if (looksLikeAsset(path) || path.startsWith(API_PREFIX)) {
    return finish(new Response("Not found", { status: 404 }), "no-store", csp);
  }

  // Every other path is a view. The app parses it and renders from there, so a
  // cold load of any deep link lands exactly where the link says.
  const index = ctx.assets.files["/index.html"];
  if (!index) return finish(new Response("Not found", { status: 404 }), "no-store", csp);
  return finish(
    new Response(Bun.file(index), { headers: { "content-type": contentTypeFor("/index.html") } }),
    cacheControlFor("/index.html"),
    csp,
  );
}

/**
 * Bind and serve. `hostname` is 127.0.0.1 unless the bind rule widened it; a
 * container without IPv6 cannot bind "::", so that retries as IPv4-only rather
 * than leaving the console down.
 */
export function startUiServer(
  ctx: UiServerCtx,
  hostname: string,
  fallbackHostname?: string,
): Server<undefined> {
  const serveOn = (host: string): Server<undefined> => {
    try {
      return Bun.serve({
        hostname: host,
        port: ctx.port,
        fetch: (req) => handleUiRequest(req, ctx),
      });
    } catch (err) {
      if (fallbackHostname && host !== fallbackHostname) return serveOn(fallbackHostname);
      throw err;
    }
  };
  return serveOn(hostname);
}

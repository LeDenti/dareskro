/**
 * Presence verifier — is the agreed publication still online, with the agreed
 * text? Hardened for real platforms, used by the oracle (oracle/oracle.mjs),
 * the campaign service (server.mjs) and the CLI (verify.mjs).
 *
 * One call, one OBSERVATION: a timestamped, self-contained record of what was
 * seen — the method used, the HTTP status, the final URL after redirects, the
 * SHA-256 of the bytes read, whether the text was found and an excerpt around
 * it. The oracle keeps every observation as evidence (oracle/observations/).
 *
 * Platforms:
 *   x        a post on x.com / twitter.com (…/status/<id>). Read without any key
 *            through three public doors, in order: the syndication JSON
 *            (cdn.syndication.twimg.com), the oEmbed endpoint (publish.x.com),
 *            the post page itself (its <meta og:description>). A deleted or
 *            protected post answers 404 on all three (measured 31/10/2026).
 *            The post's identity is its numeric id: the handle in the URL is
 *            only reported. Links in a post are shortened by X (t.co): the
 *            expanded and display URLs from the entities are part of the text
 *            that is searched, so "bottomradar.com" is found even when the post
 *            shows https://t.co/….
 *   youtube  a video (watch?v=, youtu.be/, /shorts/, /live/). oEmbed gives the
 *            title and the channel without a key; the watch page, read with the
 *            EU consent cookie, gives the description and the playability
 *            status (private, removed). Title + description are searched.
 *            NOT verifiable without a Data API key: comments (a pinned comment
 *            is not read), the exact publication time, view counts.
 *   web      any other page: redirects are followed and recorded; a redirect
 *            that leaves the agreed site is NOT live (a parked domain, a
 *            homepage catch-all). Script and style tags are dropped, entities
 *            decoded, and the text is searched in the visible text and in the
 *            raw HTML (meta tags count). A page that ships an empty shell and
 *            draws itself in JavaScript is reported as such: its text cannot be
 *            verified server-side, and the observation says so instead of
 *            saying "not there".
 *
 * Matching: Unicode NFKC, lower case, whitespace collapsed, zero-width
 * characters removed; a required text that looks like a URL also matches
 * without its scheme and without "www.".
 */
import { createHash } from "node:crypto";

const UA = "dareskro-oracle/1.0 (+https://github.com/LeDenti/dareskro; presence check)";
const DEFAULT_TIMEOUT_MS = 15000;

export const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");

// ------------------------------------------------------------------ text

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”" };
export function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

/** What two texts are compared as: NFKC, lower case, no zero-width, one space between words. */
export function normalizeText(s) {
  return decodeEntities(String(s ?? ""))
    .normalize("NFKC")
    .replace(/[​-‏⁠﻿]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** The visible text of an HTML document: no script/style/noscript, tags dropped, entities decoded. */
export function htmlToText(html) {
  return normalizeText(
    String(html)
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
}

/** The forms a required text is looked for under: itself, and for a URL, without scheme and www. */
export function requiredForms(mustContain) {
  const base = normalizeText(mustContain);
  const forms = new Set([base]);
  const m = base.match(/^(?:https?:\/\/)?(?:www\.)?(.+?)\/?$/);
  if (m && /^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/.test(m[1])) {
    forms.add(m[1]);
    forms.add(`www.${m[1]}`);
  }
  return [...forms].filter(Boolean);
}

/** Where (and whether) the required text sits in a corpus: the matched form and an excerpt around it. */
export function findText(corpus, mustContain) {
  if (!mustContain) return { found: true, form: null, excerpt: corpus.slice(0, 160) };
  const hay = normalizeText(corpus);
  for (const form of requiredForms(mustContain)) {
    const i = hay.indexOf(form);
    if (i >= 0) {
      const a = Math.max(0, i - 80);
      const b = Math.min(hay.length, i + form.length + 80);
      return { found: true, form, excerpt: `${a > 0 ? "…" : ""}${hay.slice(a, b)}${b < hay.length ? "…" : ""}` };
    }
  }
  return { found: false, form: null, excerpt: hay.slice(0, 160) + (hay.length > 160 ? "…" : "") };
}

// ------------------------------------------------------------------ urls

export function platformOf(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return "web";
  }
  const host = u.hostname.replace(/^www\.|^mobile\.|^m\./, "");
  if ((host === "x.com" || host === "twitter.com") && /\/status\/\d+/.test(u.pathname)) return "x";
  if (host === "youtube.com" || host === "youtu.be" || host === "youtube-nocookie.com") return "youtube";
  return "web";
}

export const tweetId = (url) => new URL(url).pathname.match(/\/status\/(\d+)/)?.[1] ?? null;
export const tweetHandle = (url) => new URL(url).pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\//)?.[1] ?? null;

export function youtubeId(url) {
  const u = new URL(url);
  const host = u.hostname.replace(/^www\.|^m\./, "");
  if (host === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
  if (u.searchParams.get("v")) return u.searchParams.get("v");
  const m = u.pathname.match(/\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

/** The registrable part of a host, roughly: the last two labels (three under a two-letter TLD like co.uk). */
export function siteOf(hostname) {
  const p = hostname.toLowerCase().split(".");
  if (p.length <= 2) return p.join(".");
  const tld = p.at(-1);
  const sld = p.at(-2);
  return tld.length === 2 && ["co", "com", "org", "net", "ac", "gov", "edu"].includes(sld) ? p.slice(-3).join(".") : p.slice(-2).join(".");
}

// ----------------------------------------------------------------- fetch

/** One HTTP read with a timeout and a descriptive UA; a network error is a result, not an exception. */
async function read(url, { timeoutMs, headers = {}, fetchImpl }) {
  const t0 = Date.now();
  try {
    const res = await fetchImpl(url, {
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": UA, Accept: "text/html,application/json;q=0.9,*/*;q=0.8", "Accept-Language": "fr,en;q=0.8", ...headers },
    });
    const body = Buffer.from(await res.arrayBuffer());
    return { ok: true, status: res.status, finalUrl: res.url || url, contentType: res.headers.get("content-type") ?? "", body, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, status: 0, finalUrl: url, contentType: "", body: Buffer.alloc(0), ms: Date.now() - t0, error: String(err?.cause?.message ?? err?.message ?? err).split("\n")[0] };
  }
}

/** A transient failure (timeout, reset, 5xx) is read once more after a pause; a 404 is final. */
async function readWithRetry(url, opts) {
  let r = await read(url, opts);
  if ((!r.ok || r.status >= 500 || r.status === 429) && opts.retries > 0) {
    await new Promise((res) => setTimeout(res, opts.retryDelayMs));
    r = await read(url, { ...opts, retries: opts.retries - 1 });
    r.retried = true;
  }
  return r;
}

// ------------------------------------------------------------- platforms

/** The undocumented token the syndication endpoint expects; any value worked on 31/10/2026, this is the one its embed uses. */
const syndicationToken = (id) => ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");

async function observeX(url, mustContain, opts) {
  const id = tweetId(url);
  const handle = tweetHandle(url);
  const doors = [];
  const gone = [];
  // door 1: syndication JSON — text, entities (expanded links), author
  const s = await readWithRetry(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${syndicationToken(id)}`, opts);
  doors.push({ method: "syndication", status: s.status, ms: s.ms, error: s.error });
  if (s.ok && s.status === 200 && /json/.test(s.contentType)) {
    try {
      const j = JSON.parse(s.body.toString("utf8"));
      if (j.__typename === "Tweet" && j.id_str === id) {
        const links = [...(j.entities?.urls ?? []), ...(j.entities?.media ?? [])].flatMap((u) => [u.expanded_url, u.display_url, u.url]).filter(Boolean);
        const corpus = [j.text, ...links, j.user?.screen_name ? `@${j.user.screen_name}` : ""].join("\n");
        return finish({ method: "syndication", status: 200, finalUrl: `https://x.com/${j.user?.screen_name ?? "i"}/status/${id}`, body: s.body, corpus, author: j.user?.screen_name ?? null, publishedAt: j.created_at ?? null, handle, doors });
      }
      if (j.__typename === "TweetTombstone") gone.push("syndication: tombstone (deleted or withheld)");
    } catch {
      /* not JSON after all: fall through */
    }
  } else if (s.status === 404) gone.push("syndication: 404");
  // door 2: oEmbed — the rendered blockquote, display URLs as anchor text
  const o = await readWithRetry(`https://publish.twitter.com/oembed?url=${encodeURIComponent(`https://x.com/i/status/${id}`)}&omit_script=1&dnt=1`, opts);
  doors.push({ method: "oembed", status: o.status, ms: o.ms, error: o.error });
  if (o.ok && o.status === 200 && /json/.test(o.contentType)) {
    try {
      const j = JSON.parse(o.body.toString("utf8"));
      const canonicalId = String(j.url ?? "").match(/\/status\/(\d+)/)?.[1];
      if (j.html && (!canonicalId || canonicalId === id)) {
        const author = String(j.author_url ?? "").split("/").filter(Boolean).at(-1) ?? null;
        return finish({ method: "oembed", status: 200, finalUrl: j.url ?? url, body: o.body, corpus: htmlToText(j.html), author, publishedAt: null, handle, doors });
      }
    } catch {
      /* fall through */
    }
  } else if (o.status === 404) gone.push("oembed: 404");
  // door 3: the post page itself — server-rendered <meta> carry the text
  const p = await readWithRetry(`https://x.com/i/status/${id}`, opts);
  doors.push({ method: "page", status: p.status, ms: p.ms, error: p.error });
  if (p.ok && p.status === 200) {
    const html = p.body.toString("utf8");
    const meta = [...html.matchAll(/<meta\s+(?:property|name)="(?:og:description|description|twitter:description|og:title)"\s+content="([^"]*)"/g)].map((m) => decodeEntities(m[1]));
    const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
    if (meta.length || title) {
      const author = decodeEntities(title).match(/^(?:.*?\(@([A-Za-z0-9_]+)\)|([^ ]+) on X)/)?.[2] ?? null;
      return finish({ method: "page", status: 200, finalUrl: p.finalUrl, body: p.body, corpus: [...meta, title].join("\n"), author, publishedAt: null, handle, doors });
    }
  } else if (p.status === 404) gone.push("page: 404");
  const why = gone.length ? `post ${id} gone — ${gone.join(", ")}` : `post ${id} unreadable — ${doors.map((d) => `${d.method} ${d.status || d.error}`).join(", ")}`;
  return { platform: "x", method: gone.length ? "all" : "none", status: gone.length ? 404 : (p.status || o.status || s.status || 0), finalUrl: url, redirected: false, live: false, textFound: null, ok: false, why, author: null, doors, bodySha256: null, bytes: 0, unreadable: !gone.length };

  function finish({ method, status, finalUrl, body, corpus, author, publishedAt, handle, doors }) {
    const t = findText(corpus, mustContain);
    const handleNote = handle && author && handle.toLowerCase() !== author.toLowerCase() ? ` (URL says @${handle}, post is by @${author})` : "";
    const ok = t.found;
    return {
      platform: "x", method, status, finalUrl, redirected: false, live: true, textFound: mustContain ? t.found : null, ok,
      why: ok ? `post live by @${author ?? "?"}${mustContain ? ` with "${mustContain}"` : ""}${handleNote}` : `post live by @${author ?? "?"} but without "${mustContain}"${handleNote}`,
      author, publishedAt, excerpt: t.excerpt, matchedForm: t.form, doors, bodySha256: sha256hex(body), bytes: body.length,
    };
  }
}

async function observeYouTube(url, mustContain, opts) {
  const id = youtubeId(url);
  if (!id) return { platform: "youtube", method: "none", status: 0, finalUrl: url, live: false, textFound: null, ok: false, why: "no video id in the URL", doors: [] };
  const watch = `https://www.youtube.com/watch?v=${id}`;
  const doors = [];
  const o = await readWithRetry(`https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json`, opts);
  doors.push({ method: "oembed", status: o.status, ms: o.ms, error: o.error });
  let title = null;
  let author = null;
  if (o.ok && o.status === 200) {
    try {
      const j = JSON.parse(o.body.toString("utf8"));
      title = j.title ?? null;
      author = j.author_name ?? null;
    } catch { /* not JSON */ }
  }
  // the watch page: description and playability, no key needed; the EU consent wall is passed with a cookie
  const p = await readWithRetry(watch, { ...opts, headers: { Cookie: "CONSENT=YES+1; SOCS=CAI", "Accept-Language": "en" } });
  doors.push({ method: "page", status: p.status, ms: p.ms, error: p.error });
  let description = null;
  let playability = null;
  let pageTitle = null;
  if (p.ok && p.status === 200) {
    const html = p.body.toString("utf8");
    const grab = (key) => {
      const m = html.match(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`));
      if (!m) return null;
      try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
    };
    description = grab("shortDescription");
    playability = html.match(/"playabilityStatus":\{"status":"([A-Z_]+)"/)?.[1] ?? null;
    pageTitle = grab("title") ?? html.match(/<title>([^<]*)<\/title>/)?.[1] ?? null;
  }
  const oembedGone = [400, 401, 403, 404].includes(o.status);
  const pageGone = p.status === 404 || (playability && playability !== "OK" && playability !== "LIVE_STREAM_OFFLINE");
  if (oembedGone && (pageGone || !description)) {
    const why = `video ${id} not available — oembed ${o.status}${playability ? `, page says ${playability}` : p.status ? `, page ${p.status}` : ""}`;
    return { platform: "youtube", method: "oembed+page", status: o.status, finalUrl: watch, redirected: false, live: false, textFound: null, ok: false, why, author, doors, bodySha256: p.body.length ? sha256hex(p.body) : null, bytes: p.body.length, playability };
  }
  if (!title && !description) {
    return { platform: "youtube", method: "none", status: o.status || p.status, finalUrl: watch, redirected: false, live: false, textFound: null, ok: false, why: `video ${id} unreadable — oembed ${o.status || o.error}, page ${p.status || p.error}`, author, doors, bodySha256: null, bytes: 0, unreadable: true };
  }
  const corpus = [title ?? pageTitle ?? "", description ?? "", author ? `@${author}` : ""].join("\n");
  const t = findText(corpus, mustContain);
  const where = description !== null ? "title and description" : "title only (description not readable)";
  return {
    platform: "youtube", method: description !== null ? "oembed+page" : "oembed", status: 200, finalUrl: watch, redirected: false, live: true,
    textFound: mustContain ? t.found : null, ok: t.found,
    why: t.found ? `video live by ${author ?? "?"}${mustContain ? ` with "${mustContain}" in the ${where}` : ""}` : `video live by ${author ?? "?"} but without "${mustContain}" in the ${where}`,
    author, title: title ?? pageTitle, playability, excerpt: t.excerpt, matchedForm: t.form, doors, bodySha256: sha256hex(p.body.length ? p.body : o.body), bytes: p.body.length || o.body.length,
    limits: "comments and pinned comments are not read (Data API key needed)",
  };
}

const SHELL_MARKERS = /<div\s+id="(root|app|__next|__nuxt)"\s*>\s*<\/div>|You need to enable JavaScript to run this app|<noscript>[^<]*JavaScript/i;

async function observeWeb(url, mustContain, opts) {
  const r = await readWithRetry(url, opts);
  const doors = [{ method: "get", status: r.status, ms: r.ms, error: r.error }];
  if (!r.ok) return { platform: "web", method: "get", status: 0, finalUrl: url, redirected: false, live: false, textFound: null, ok: false, why: `unreachable: ${r.error}`, doors, bodySha256: null, bytes: 0, unreadable: true };
  const redirected = r.finalUrl !== url;
  let offSite = false;
  try {
    offSite = redirected && siteOf(new URL(r.finalUrl).hostname) !== siteOf(new URL(url).hostname);
  } catch { /* keep false */ }
  const base = { platform: "web", method: "get", status: r.status, finalUrl: r.finalUrl, redirected, contentType: r.contentType, doors, bodySha256: sha256hex(r.body), bytes: r.body.length };
  if (r.status < 200 || r.status >= 300) return { ...base, live: false, textFound: null, ok: false, why: `HTTP ${r.status}${redirected ? ` after redirect to ${r.finalUrl}` : ""}` };
  if (offSite) return { ...base, live: false, textFound: null, ok: false, why: `redirected off-site to ${r.finalUrl}: the agreed page is gone` };
  const html = r.body.toString("utf8");
  const isHtml = /html/.test(r.contentType) || /^\s*<(!doctype|html)/i.test(html);
  const text = isHtml ? htmlToText(html) : normalizeText(html);
  const corpus = isHtml ? `${text}\n${html}` : text;
  const t = findText(corpus, mustContain);
  const shell = isHtml && text.length < 200 && SHELL_MARKERS.test(html);
  if (!t.found && shell) {
    return { ...base, live: true, textFound: false, jsRendered: true, ok: false, why: `page answers 200 but draws itself in JavaScript (${text.length} chars of text server-side): "${mustContain}" not verifiable without a browser`, excerpt: t.excerpt };
  }
  return {
    ...base, live: true, textFound: mustContain ? t.found : null, ok: t.found, jsRendered: shell || undefined,
    why: t.found ? `live${mustContain ? ` with "${mustContain}"` : ""} (${text.length} chars${redirected ? `, via ${r.finalUrl}` : ""})` : `live but without "${mustContain}" (${text.length} chars${redirected ? `, via ${r.finalUrl}` : ""})`,
    excerpt: t.excerpt, matchedForm: t.form,
  };
}

// ------------------------------------------------------------------ main

/**
 * Look once. Returns an observation:
 *   { at, url, mustContain, platform, method, status, finalUrl, redirected, live,
 *     textFound, ok, why, author?, excerpt?, bodySha256, bytes, doors[], ms }
 * `ok` is the oracle's answer: live AND (no required text, or the text found).
 * `why` is one line a human can read in the journal.
 */
export async function observe(url, mustContain = "", options = {}) {
  const opts = { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, retries: options.retries ?? 1, retryDelayMs: options.retryDelayMs ?? 2000, fetchImpl: options.fetchImpl ?? fetch };
  const at = new Date().toISOString();
  const t0 = Date.now();
  let platform;
  try {
    new URL(url);
    platform = platformOf(url);
  } catch {
    return { at, url, mustContain, platform: "web", method: "none", status: 0, live: false, textFound: null, ok: false, why: "not a URL", doors: [], ms: 0 };
  }
  const by = { x: observeX, youtube: observeYouTube, web: observeWeb }[platform];
  const obs = await by(url, mustContain, opts);
  return { at, url, mustContain: mustContain || null, ...obs, ms: Date.now() - t0 };
}

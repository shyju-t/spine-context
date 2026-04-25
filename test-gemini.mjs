/**
 * Probe every Gemini model we've evaluated, side-by-side.
 *
 * Usage:
 *   node --env-file=.env.local test-gemini.mjs
 *
 * Sequential (with a small inter-call delay) so we don't trip RPM limits
 * with the probe itself. Each row shows status, latency, response text,
 * and token usage. On failure, the full Google error body is dumped so
 * you can distinguish RPM / RPD / TPM exhaustion vs auth vs not-found.
 */

const MODELS = [
  "gemini-2.5-flash",                  // the main one we used
  "gemini-2.5-flash-lite",             // cheaper bucket; sparse facts
  "gemini-2.0-flash",                  // deprecated for new users
  "gemini-flash-latest",               // alias to current flash
  "gemini-flash-lite-latest",          // alias to current flash-lite
  "gemini-3-flash-preview",            // 3.x preview
  "gemini-3.1-flash-lite-preview",     // 3.1 lite preview
];

const DELAY_MS = 1500;
const PROMPT = "Reply with exactly: OK";

const key =
  process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY;
if (!key) {
  console.error("Missing GOOGLE_GENERATIVE_AI_API_KEY in env.");
  console.error("Run with:  node --env-file=.env.local test-gemini.mjs");
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function probeOne(model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const body = { contents: [{ parts: [{ text: PROMPT }] }] };
  const t0 = Date.now();
  let res, text;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    text = await res.text();
  } catch (err) {
    return {
      model,
      ok: false,
      status: 0,
      ms: Date.now() - t0,
      reply: "",
      error: `network: ${err.message}`,
      raw: "",
    };
  }
  const ms = Date.now() - t0;

  if (!res.ok) {
    let summary = `${res.status} ${res.statusText}`;
    try {
      const parsed = JSON.parse(text);
      summary = parsed?.error?.message ?? summary;
    } catch {}
    return {
      model,
      ok: false,
      status: res.status,
      ms,
      reply: "",
      error: summary,
      raw: text,
    };
  }

  const data = JSON.parse(text);
  const reply =
    data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "(empty)";
  const usage = data?.usageMetadata || {};
  return {
    model,
    ok: true,
    status: res.status,
    ms,
    reply,
    error: "",
    usage,
    raw: "",
  };
}

function pad(s, n) {
  s = String(s);
  if (s.length >= n) return s.slice(0, n);
  return s + " ".repeat(n - s.length);
}

async function main() {
  const results = [];
  for (const m of MODELS) {
    process.stdout.write(`probing ${m}... `);
    const r = await probeOne(m);
    process.stdout.write(r.ok ? "✓\n" : `✗ (${r.status})\n`);
    results.push(r);
    await sleep(DELAY_MS);
  }

  console.log("\n=== summary ===");
  console.log(
    pad("model", 36) +
      pad("status", 9) +
      pad("ms", 7) +
      pad("reply / error", 80),
  );
  console.log("─".repeat(132));
  for (const r of results) {
    const statusCell = r.ok ? "✓ 200" : `✗ ${r.status || "ERR"}`;
    const detail = r.ok
      ? `${r.reply}  [in:${r.usage?.promptTokenCount ?? "?"} out:${r.usage?.candidatesTokenCount ?? "?"}]`
      : r.error.slice(0, 78);
    console.log(
      pad(r.model, 36) + pad(statusCell, 9) + pad(`${r.ms}`, 7) + detail,
    );
  }

  // Dump full Google error body for failures — that's where RPM vs RPD lives.
  const failed = results.filter((r) => !r.ok && r.raw);
  if (failed.length > 0) {
    console.log("\n=== full error bodies (RPM vs RPD vs auth diagnosis) ===");
    for (const r of failed) {
      console.log(`\n--- ${r.model} ---`);
      try {
        console.log(JSON.stringify(JSON.parse(r.raw), null, 2));
      } catch {
        console.log(r.raw);
      }
    }
  }

  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} models reachable.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

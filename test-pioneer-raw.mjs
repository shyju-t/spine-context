/**
 * Raw Pioneer probe — issues the same request callPioneer would, but
 * doesn't apply the mapper. Prints whatever the API returns so we can
 * see the actual response shape.
 */
const apiKey = process.env.PIONEER_API_KEY;
if (!apiKey) { console.error("PIONEER_API_KEY not set"); process.exit(1); }

const model = process.env.PIONEER_MODEL ?? "fastino/gliner2-multi-large-v1";

const body = {
  model,
  messages: [
    {
      role: "user",
      content:
        "Hi Alice, quick update on the Phoenix migration project. Bob is still owning the schema work, but he's blocked on the Q3 budget review. We need to commit to drafting the new vendor contract by Friday. Customer Acme Corp has been pushing for an earlier ship date.",
    },
  ],
  schema: {
    entities: [
      "person",
      "customer",
      "client",
      "vendor",
      "product",
      "project",
      "topic",
      "decision",
      "commitment",
    ],
    relations: [
      "manages",
      "reports_to",
      "owns",
      "assigned_to",
      "blocks",
      "blocked_by",
      "decided_by",
      "due_on",
      "discussed_with",
    ],
  },
  include_confidence: true,
  include_spans: true,
};

console.log(`→ Pioneer (${model})...`);
const t0 = performance.now();
const res = await fetch("https://api.pioneer.ai/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify(body),
});
const elapsed = performance.now() - t0;

console.log(`status: ${res.status} ${res.statusText}`);
console.log(`elapsed: ${elapsed.toFixed(0)}ms`);
console.log();

const text = await res.text();
try {
  const json = JSON.parse(text);
  console.log("─── full JSON response ───");
  console.log(JSON.stringify(json, null, 2));
} catch {
  console.log("─── non-JSON response ───");
  console.log(text);
}

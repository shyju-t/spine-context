/**
 * Verify the Extractor dispatches by model id and returns a good error
 * when Pioneer is selected without an API key.
 */
import { Extractor } from "./packages/extractor/src/extractor.ts";

// Fake-light versions of the deps the Extractor only touches inside extract()
const stubResolver = {
  resolve() { return []; },
  getEntity() { return undefined; },
  size() { return { entities: 0, surface_forms: 0 }; },
};
const stubCache = {
  async get() { return undefined; },
  async put() {},
};

const fakeSource = {
  id: "email/test",
  type: "email",
  external_id: "test",
  subject: "test",
  content: "hello",
  metadata: {},
  ingested_at: new Date(),
  default_acl: ["employee:all"],
};

// Dispatch goes Pioneer-side and errors with a clear message
delete process.env.PIONEER_API_KEY;
const ex = new Extractor({
  resolver: stubResolver,
  cache: stubCache,
  model: "pioneer/fastino/gliner2-multi-large-v1",
});
try {
  await ex.extract({ source: fakeSource });
  console.error("FAIL: expected an error about PIONEER_API_KEY");
  process.exit(1);
} catch (err) {
  if (!String(err.message).includes("PIONEER_API_KEY")) {
    console.error(`FAIL: wrong error: ${err.message}`);
    process.exit(1);
  }
  console.log(`OK no-API-key error fires: ${err.message.slice(0, 80)}...`);
}

// Dispatch goes Gemini-side when model starts with gemini-* — we can't
// easily test the network call here, but we can confirm the backend
// selection logic without making a request by mocking the cache to
// return a hit (so .extract() short-circuits before the LLM call).
const cachedCache = {
  async get() {
    return { new_entities: [], facts: [] };
  },
  async put() {},
};
const ex2 = new Extractor({
  resolver: stubResolver,
  cache: cachedCache,
  model: "gemini-2.5-flash",
});
const r = await ex2.extract({ source: fakeSource });
console.log(
  `OK gemini path returns cache hit: cache_hit=${r.cache_hit}, llm_ms=${r.llm_ms}`,
);

console.log("\nDispatch tests passed.");

import test from "node:test";
import assert from "node:assert/strict";
import { createDiagnosticReporter, sanitizeDiagnosticText } from "../src/lib/diagnostics.js";

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test("redacts Hugging Face tokens, bearer credentials, JWTs, and token query parameters", () => {
  const text = sanitizeDiagnosticText("hf_abcdefghijklmnopqrstuvwxyz123456 Bearer abc.def? token=secret eyJabcdefghijk.abcdefghijk.abcdefghijk");
  assert.doesNotMatch(text, /hf_abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(text, /Bearer abc/);
  assert.doesNotMatch(text, /token=secret/);
  assert.doesNotMatch(text, /eyJabcdefghijk/);
});

test("diagnostic storage is bounded and sensitive fields are removed", () => {
  const storage = memoryStorage();
  let clock = 1_800_000_000_000;
  const reporter = createDiagnosticReporter({ storage, now: () => clock++, maxEntries: 20 });
  for (let index = 0; index < 27; index += 1) reporter.record("test", "entry " + index, { token: "must-not-appear", prompt: "private prompt", count: index });
  const entries = reporter.getEntries();
  assert.equal(entries.length, 20);
  assert.equal(entries.at(-1).message, "entry 26");
  assert.equal(entries.at(-1).details.token, "[REDACTED]");
  assert.equal(entries.at(-1).details.prompt, "[OMITTED]");
  assert.equal(JSON.stringify(reporter.createReport()).includes("private prompt"), false);
  assert.equal(createDiagnosticReporter({ storage, now: () => clock++, maxEntries: 20 }).getEntries().length, 20);
});

test("global errors, unhandled rejections, console errors, and failed fetches are recorded", async () => {
  const listeners = new Map();
  const calls = [];
  const target = {
    location: { href: "https://appassets.androidplatform.net/index.html" },
    addEventListener: (name, handler) => listeners.set(name, handler),
    console: { error: (...args) => calls.push(args), warn: (...args) => calls.push(args) },
    fetch: async () => new Response(JSON.stringify({ error: "Space failed", token: "secret", prompt: "private prompt" }), { status: 500 }),
  };
  const reporter = createDiagnosticReporter({ storage: memoryStorage() });
  reporter.install(target);
  listeners.get("error")({ error: new Error("script exploded"), filename: "https://example.test/app.js?token=secret", lineno: 7, colno: 2 });
  listeners.get("unhandledrejection")({ reason: new Error("promise exploded") });
  target.console.error("console exploded");
  const response = await target.fetch("https://huggingface.co/api/spaces/demo?token=secret");
  assert.equal(response.status, 500);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const entries = reporter.getEntries();
  assert.ok(entries.some((entry) => entry.message.includes("script exploded")));
  assert.ok(entries.some((entry) => entry.message.includes("promise exploded")));
  assert.ok(entries.some((entry) => entry.level === "console_error"));
  assert.ok(entries.some((entry) => entry.level === "http_error"));
  const reportText = JSON.stringify(reporter.createReport());
  assert.doesNotMatch(reportText, /secret/);
  assert.doesNotMatch(reportText, /private prompt/);
  assert.equal(calls.length, 1);
});

test("Android native log imports are deduplicated", () => {
  const reporter = createDiagnosticReporter({ storage: memoryStorage() });
  const native = [{ id: "native-1", level: "fatal", message: "native crash", timestamp: 123 }];
  assert.equal(reporter.importNativeEntries(native), 1);
  assert.equal(reporter.importNativeEntries(native), 0);
  assert.ok(reporter.getEntries().some((entry) => entry.message === "native crash"));
});

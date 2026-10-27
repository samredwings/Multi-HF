import test from "node:test";
import assert from "node:assert/strict";
import { tokenHeaders, sanitizeWorkspace, persistableResult, recoverRunningJobs, readGradioStream, classifyFailure } from "../src/lib/core.js";

const stream = (text) => new Response(text);

test("token goes to the Hub, and to hf.space only for private Spaces", () => {
  assert.deepEqual(tokenHeaders("t", "https://huggingface.co/api/spaces/a/b"), { Authorization: "Bearer t" });
  assert.deepEqual(tokenHeaders("t", "https://evil.hf.space/config"), {});
  assert.deepEqual(tokenHeaders("t", "https://own.hf.space/config", { privateSpace: true }), { Authorization: "Bearer t" });
  assert.deepEqual(tokenHeaders("t", "https://attacker.example/x", { privateSpace: true }), {});
  assert.deepEqual(tokenHeaders("t", "http://huggingface.co/api"), {});
  assert.deepEqual(tokenHeaders("t", "https://huggingface.co.evil.com/"), {});
  assert.deepEqual(tokenHeaders(null, "https://huggingface.co/"), {});
});

const model = { id: "a/b", host: "https://a-b.hf.space", endpoints: [{ apiName: "generate", fields: [{ key: "c1", type: "text" }], outputs: [{ key: "o2", label: "x", type: "image" }] }], task: "image" };

test("import drops models with non-hf.space hosts and their jobs", () => {
  const ws = sanitizeWorkspace({ workspace: {
    models: [model, { ...model, id: "evil", host: "https://attacker.example" }],
    profiles: [], accounts: [{ id: "acc", label: "me", token: "hf_secret" }],
    jobs: [
      { id: "j1", modelId: "a/b", apiName: "generate", accountId: "acc", status: "running", result: [{ kind: "image", url: "javascript:alert(1)" }, { kind: "image", url: "https://x.example/o.png" }] },
      { id: "j2", modelId: "evil", apiName: "generate", status: "ready" },
    ],
  } });
  assert.equal(ws.models.length, 1);
  assert.equal(ws.jobs.length, 1);
  assert.equal(ws.jobs[0].status, "paused");
  assert.equal(ws.jobs[0].result.length, 1);
  assert.equal("token" in ws.accounts[0], false);
  assert.throws(() => sanitizeWorkspace({ models: 1 }), /not a Multi-HF/);
});

test("oversized inline media is not persisted; running jobs are recovered", () => {
  const big = { kind: "image", url: `data:image/png;base64,${"A".repeat(60_000)}`, label: "x" };
  assert.equal(persistableResult([big])[0].kind, "text");
  assert.equal(persistableResult([{ kind: "image", url: "https://x.example/a.png" }])[0].kind, "image");
  assert.equal(recoverRunningJobs([{ id: "1", status: "running" }, { id: "2", status: "done" }])[0].status, "paused");
});

test("SSE reader handles CRLF, progress events and completion", async () => {
  const seen = [];
  const data = await readGradioStream(stream('event: generating\r\ndata: {"progress":0.5}\r\n\r\nevent: complete\r\ndata: ["https://x.example/o.png"]\r\n\r\n'), (p) => seen.push(p));
  assert.deepEqual(data, ["https://x.example/o.png"]);
  assert.equal(seen[0].progress, 0.5);
});

test("SSE error with a plain-string payload keeps its text so quota is classified", async () => {
  await assert.rejects(
    readGradioStream(stream('event: error\ndata: "You have exceeded your GPU quota"\n\n')),
    (err) => { assert.match(err.message, /GPU quota/); assert.equal(classifyFailure(undefined, err.message), "quota"); return true; },
  );
  await assert.rejects(readGradioStream(stream("event: error\ndata: null\n\n")), /no details/);
  await assert.rejects(readGradioStream(stream("event: heartbeat\ndata: null\n\n")), /ended before/);
});

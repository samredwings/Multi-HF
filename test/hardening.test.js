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

const model = { id: "a/b", host: "https://a-b.hf.space", sendToken: true, endpoints: [{ apiName: "generate", fields: [{ key: "c1", type: "text" }], outputs: [{ key: "o2", label: "x", type: "image" }] }], task: "image" };

test("import drops models with non-hf.space hosts and their jobs", () => {
  const ws = sanitizeWorkspace({ workspace: {
    models: [model, { ...model, id: "evil", host: "https://attacker.example" }],
    profiles: [], accounts: [{ id: "acc", label: "me", token: "hf_secret" }],
    jobs: [
      { id: "j1", modelId: "a/b", apiName: "generate", accountId: "acc", status: "running", remoteEventId: "event-1", phase: "Submitted", result: [{ kind: "image", url: "javascript:alert(1)" }, { kind: "image", url: "https://x.example/o.png" }] },
      { id: "j2", modelId: "evil", apiName: "generate", status: "ready" },
    ],
  } });
  assert.equal(ws.models.length, 1);
  assert.equal(ws.jobs.length, 1);
  assert.equal(ws.jobs[0].status, "paused");
  assert.equal(ws.jobs[0].remoteEventId, "event-1");
  assert.equal(ws.jobs[0].phase, "Submitted");
  assert.equal(ws.models[0].sendToken, true);
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

test("workspace import keeps UI-only Spaces with a recognized framework", () => {
  const imported = sanitizeWorkspace({
    models: [
      { id: "demo/streamlit", host: "https://demo-streamlit.hf.space", framework: "streamlit", endpoints: [] },
      { id: "demo/gradio-ui", host: "https://demo-gradio.hf.space", framework: "gradio", endpoints: [], gradioVersion: "5.12.0" },
      { id: "unknown/ui", host: "https://unknown-ui.hf.space", framework: "unknown", endpoints: [] }
    ],
    profiles: [], jobs: [], accounts: []
  });
  assert.deepEqual(imported.models.map((item) => item.framework), ["streamlit", "gradio"]);
  assert.equal(imported.models[1].activeApi, "");
});


test("running jobs with a remote Gradio event recover without losing the event id", () => {
  const recovered = recoverRunningJobs([
    { id: "remote-1", status: "running", remoteEventId: "event-123", modelId: "a/b" },
    { id: "local-1", status: "running", modelId: "a/b" }
  ]);
  assert.equal(recovered[0].status, "paused");
  assert.equal(recovered[0].remoteEventId, "event-123");
  assert.match(recovered[0].error, /Resume its result stream/i);
  assert.equal(recovered[1].status, "paused");
  assert.doesNotMatch(recovered[1].error, /event ID/i);
});

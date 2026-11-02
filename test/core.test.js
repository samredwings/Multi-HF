import test from "node:test";
import assert from "node:assert/strict";
import { parseSpaceInput, parseSpaceConfig, taskFromEndpoints, classifyFailure, holdFor, normalizeOutputs, normalizeHost, normalizeGradioVersion, normalizeSpaceFramework, nextQueueBatch, normalizeZeroGpuQuota, admitQueueJobsByQuota, limitQueueBatchWithoutQuota } from "../src/lib/core.js";

test("parses accepted Space identifiers and rejects arbitrary hosts", () => {
  assert.deepEqual(parseSpaceInput("owner/space-name"), { id: "owner/space-name", host: null });
  assert.deepEqual(parseSpaceInput("https://huggingface.co/spaces/owner/space-name"), { id: "owner/space-name", host: null });
  assert.equal(parseSpaceInput("https://demo-owner.hf.space").host, "https://demo-owner.hf.space");
  assert.throws(() => parseSpaceInput("http://huggingface.co/spaces/a/b"), /HTTPS/);
  assert.throws(() => parseSpaceInput("https://example.com"), /only connects/i);
});

test("normalizes Space hosts without accepting arbitrary remote URLs", () => {
  assert.equal(normalizeHost("worker.hf.space"), "https://worker.hf.space");
  assert.equal(normalizeHost("http://example.com"), "");
  assert.equal(normalizeHost(null, "valid-space-name"), "https://valid-space-name.hf.space");
});

test("parses Gradio components, defaults, and prioritizes media endpoints", () => {
  const config = {
    title: "🎬 Demo Space",
    api_prefix: "/gradio_api",
    components: [
      { id: 1, type: "textbox", props: { label: "Prompt", lines: 3, value: "hello" } },
      { id: 2, type: "slider", props: { label: "Steps", minimum: 1, maximum: 50, value: 20 } },
      { id: 3, type: "video", props: { label: "Generated video" } },
      { id: 4, type: "textbox", props: { label: "Debug text" } },
    ],
    dependencies: [
      { api_name: "debug", inputs: [4], outputs: [4] },
      { api_name: "generate_video", inputs: [1, 2], outputs: [3] },
      { api_name: "_internal", inputs: [1], outputs: [4] },
    ],
  };
  const result = parseSpaceConfig(config);
  assert.equal(result.title, "Demo Space");
  assert.equal(result.endpoints[0].apiName, "generate_video");
  assert.equal(result.endpoints[0].fields[0].type, "textarea");
  assert.equal(result.endpoints[0].fields[1].defaultValue, 20);
  assert.equal(taskFromEndpoints(result.endpoints), "video");
  assert.throws(() => parseSpaceConfig({ components: [], dependencies: [] }), /No runnable API/);
});

test("classifies errors and does not fabricate quota reset timestamps", () => {
  assert.equal(classifyFailure(401, "Unauthorized"), "auth");
  assert.equal(classifyFailure(402, "Payment required"), "quota");
  assert.equal(classifyFailure(503, "Upstream unavailable"), "transient");
  assert.equal(classifyFailure(undefined, "Failed to fetch"), "transient");
  assert.equal(classifyFailure(undefined, "The operation was aborted"), "transient");
  assert.equal(classifyFailure(200, "content policy blocked"), "policy");
  assert.equal(holdFor("quota", "GPU quota exceeded", null, 1000), null);
  assert.equal(holdFor("quota", "GPU quota exceeded", "2030-01-01T00:00:00Z", 1000), Date.parse("2030-01-01T00:00:00Z"));
  assert.equal(holdFor("transient", "HTTP 429 Too Many Requests", null, 1000), 121000);
});

test("normalizes image, video, file, and text outputs", () => {
  assert.equal(normalizeOutputs("https://cdn.example/out.png", "x")[0].kind, "image");
  assert.equal(normalizeOutputs("https://cdn.example/out.mp4", "x")[0].kind, "video");
  assert.equal(normalizeOutputs("A complete sentence", "x")[0].kind, "text");
  assert.equal(normalizeOutputs([{ url: "https://cdn.example/sound.wav", mime_type: "audio/wav" }], "x")[0].kind, "audio");
});

test("normalizes Gradio runtime versions safely for UI embedding", () => {
  assert.equal(normalizeGradioVersion("v5.12.0", "4.44.1"), "5.12.0");
  assert.equal(normalizeGradioVersion("latest", "6.0"), "6.0");
  assert.equal(normalizeGradioVersion("https://evil.example/x"), "");
});

test("maps JSON, color, and date controls from Gradio config", () => {
  const config = {
    version: "5.12.0",
    components: [
      { id: 1, type: "json", props: { label: "Settings", value: { seed: 42 } } },
      { id: 2, type: "colorpicker", props: { label: "Tint", value: "#ffffff" } },
      { id: 3, type: "date", props: { label: "Start date", value: "2026-01-01" } },
      { id: 4, type: "textbox", props: { label: "Result" } }
    ],
    dependencies: [{ api_name: "generate", inputs: [1, 2, 3], outputs: [4] }]
  };
  const parsed = parseSpaceConfig(config);
  assert.equal(parsed.gradioVersion, "5.12.0");
  assert.deepEqual(parsed.endpoints[0].fields.map((field) => field.type), ["json", "color", "date"]);
  assert.equal(parsed.endpoints[0].fields[0].defaultValue, JSON.stringify({ seed: 42 }, null, 2));
});

test("identifies supported Space UI frameworks without assuming every Space is Gradio", () => {
  assert.equal(normalizeSpaceFramework("Gradio"), "gradio");
  assert.equal(normalizeSpaceFramework("streamlit"), "streamlit");
  assert.equal(normalizeSpaceFramework("docker"), "docker");
  assert.equal(normalizeSpaceFramework("unknown-runtime"), "unknown");
});


test("maps Gradio gallery and multiple-file inputs for batch jobs", () => {
  const parsed = parseSpaceConfig({
    components: [
      { id: 1, type: "gallery", props: { label: "Reference images" } },
      { id: 2, type: "file", props: { label: "Source files", file_count: "multiple" } },
      { id: 3, type: "image", props: { label: "Main image" } },
      { id: 4, type: "image", props: { label: "Output" } }
    ],
    dependencies: [{ api_name: "generate", inputs: [1, 2, 3], outputs: [4] }]
  });
  assert.deepEqual(parsed.endpoints[0].fields.map((field) => field.type), ["gallery", "file", "image"]);
  assert.equal(parsed.endpoints[0].fields[0].multiple, true);
  assert.equal(parsed.endpoints[0].fields[1].multiple, true);
  assert.equal(parsed.endpoints[0].fields[2].multiple, false);
});

test("queue batching groups the same Space and account while preserving batch order", () => {
  const jobs = [
    { id: "a1", modelId: "space/a", accountId: "acc1", status: "ready", createdAt: 1 },
    { id: "b1", modelId: "space/b", accountId: "acc1", status: "ready", createdAt: 2 },
    { id: "a2", modelId: "space/a", accountId: "acc1", status: "retry", createdAt: 3 },
    { id: "a3", modelId: "space/a", accountId: "acc2", status: "ready", createdAt: 4 },
    { id: "done", modelId: "space/a", accountId: "acc1", status: "done", createdAt: 0 }
  ];
  assert.deepEqual(nextQueueBatch(jobs).map((job) => job.id), ["a1", "a2"]);
  assert.deepEqual(nextQueueBatch(jobs, false).map((job) => job.id), ["a1"]);
  assert.deepEqual(normalizeZeroGpuQuota({ base: 300, current: 121, resetsAt: "2030-01-01T00:00:00Z", overquotaUsed: 0, runs: { used: 2, limit: 5, remaining: 3 } }), {
    base: 300, remaining: 121, resetsAt: "2030-01-01T00:00:00Z", overquotaUsed: 0,
    runs: { used: 2, limit: 5, remaining: 3, resetsAt: null }
  });
  assert.deepEqual(normalizeZeroGpuQuota({ base: 300, remaining: 121, resets_at: "2030-01-01T00:00:00Z", overquota_used: 0 }).remaining, 121);
  assert.throws(() => normalizeZeroGpuQuota({ remaining: "unknown" }), /invalid ZeroGPU quota/i);
});


test("ZeroGPU quota normalization accepts current API field names and run limits", () => {
  const quota = normalizeZeroGpuQuota({
    base: 300, current: 119, resetsAt: null, overquotaUsed: 0,
    runs: { used: 2, limit: 5, remaining: 3, resetsAt: "2030-01-01T00:00:00Z" }
  });
  assert.equal(quota.remaining, 119);
  assert.equal(quota.runs.remaining, 3);
  assert.equal(quota.runs.resetsAt, "2030-01-01T00:00:00Z");
});


test("maps complex Gradio components to structured JSON instead of invalid text or file values", () => {
  const parsed = parseSpaceConfig({
    components: [
      { id: 1, type: "imageeditor", props: { label: "Layered reference" } },
      { id: 2, type: "chatbot", props: { label: "Conversation history", value: [] } },
      { id: 3, type: "dataframe", props: { label: "Control points", value: [[1, 2]] } },
      { id: 4, type: "textbox", props: { label: "Prompt" } },
      { id: 5, type: "image", props: { label: "Result" } }
    ],
    dependencies: [{ api_name: "generate", inputs: [1, 2, 3, 4], outputs: [5] }]
  });
  assert.deepEqual(parsed.endpoints[0].fields.map((field) => field.type), ["json", "json", "json", "textarea"]);
  assert.equal(parsed.endpoints[0].fields[2].defaultValue, JSON.stringify([[1, 2]], null, 2));
});


test("quota admission reserves only jobs that fit the remaining GPU-seconds and run slots", () => {
  const jobs = Array.from({ length: 7 }, (_, index) => ({
    id: "job-" + index, reservationSeconds: 60
  }));
  const admission = admitQueueJobsByQuota(jobs, {
    remaining: 300, runs: { remaining: 4 }
  });
  assert.deepEqual(admission.admitted.map((job) => job.id), ["job-0", "job-1", "job-2", "job-3"]);
  assert.equal(admission.held.length, 3);
  assert.equal(admission.reservedSeconds, 240);
  assert.equal(admission.remainingSeconds, 60);
  const custom = admitQueueJobsByQuota([
    { id: "short-1", reservationSeconds: 30 },
    { id: "short-2", reservationSeconds: 30 },
    { id: "long", reservationSeconds: 90 }
  ], { remaining: 75 });
  assert.deepEqual(custom.admitted.map((job) => job.id), ["short-1", "short-2"]);
  assert.equal(custom.held[0].job.id, "long");
});


test("unknown ZeroGPU quota limits new submissions to one while preserving remote events", () => {
  const jobs = [
    { id: "already-submitted", remoteEventId: "evt-1" },
    { id: "fresh-1" },
    { id: "fresh-2" },
    { id: "fresh-3" }
  ];
  assert.deepEqual(limitQueueBatchWithoutQuota(jobs).map((job) => job.id), ["already-submitted", "fresh-1"]);
  assert.deepEqual(limitQueueBatchWithoutQuota([{ id: "remote", remoteEventId: "evt-2" }]).map((job) => job.id), ["remote"]);
});


test("normalizes nested Hugging Face hardware metadata for ZeroGPU detection", async () => {
  const { normalizeHardwareIdentifier } = await import("../src/lib/core.js");
  assert.equal(normalizeHardwareIdentifier({ current: { name: "zero-a10g" }, requested: "cpu-basic" }), "zero-a10g");
  assert.equal(normalizeHardwareIdentifier({ hardware: { flavor: "zero-gpu" } }), "zero-gpu");
  assert.equal(normalizeHardwareIdentifier("cpu-basic"), "cpu-basic");
  assert.equal(normalizeHardwareIdentifier({ current: null }), "");
});


test("maps Sketchpad and image editor inputs to their structured editor payloads", () => {
  const parsed = parseSpaceConfig({
    components: [
      { id: 1, type: "sketchpad", props: { label: "Draw a mask" } },
      { id: 2, type: "imageeditor", props: { label: "Edit reference" } },
      { id: 3, type: "image", props: { label: "Source image" } },
      { id: 4, type: "image", props: { label: "Output" } }
    ],
    dependencies: [{ api_name: "generate", inputs: [1, 2, 3], outputs: [4] }]
  });
  assert.deepEqual(parsed.endpoints[0].fields.map((field) => field.type), ["json", "json", "image"]);
});

import test from "node:test";
import assert from "node:assert/strict";
import { parseSpaceInput, parseSpaceConfig, taskFromEndpoints, classifyFailure, holdFor, normalizeOutputs, normalizeHost } from "../src/lib/core.js";

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

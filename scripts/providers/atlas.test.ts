import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { CliArgs } from "../types.ts";
import {
  buildInput,
  extractOutputUrl,
  generateImage,
  getAtlasSize,
  validateArgs,
} from "./atlas.ts";

function makeArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    prompt: null,
    promptFiles: [],
    imagePath: null,
    provider: "atlas",
    model: null,
    aspectRatio: null,
    size: null,
    quality: null,
    imageSize: null,
    referenceImages: [],
    n: 1,
    batchFile: null,
    jobs: null,
    json: false,
    help: false,
    ...overrides,
  };
}

function useEnv(t: TestContext, values: Record<string, string | null>): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("Atlas input maps quality and aspect ratio to the verified model schema", () => {
  const args = makeArgs({ aspectRatio: "16:9", quality: "2k" });
  assert.equal(getAtlasSize(args), "2048x1152");
  assert.deepEqual(
    buildInput("A studio product photo", "openai/gpt-image-2/text-to-image", args),
    {
      model: "openai/gpt-image-2/text-to-image",
      prompt: "A studio product photo",
      size: "2048x1152",
      quality: "high",
      output_format: "png",
      enable_sync_mode: false,
      enable_base64_output: false,
    },
  );

  assert.equal(getAtlasSize(makeArgs({ aspectRatio: "9:16", quality: "normal" })), "768x1024");
  assert.equal(getAtlasSize(makeArgs({ size: "1536x1024" })), "1536x1024");
});

test("Atlas rejects reference images for the text-to-image route", () => {
  assert.throws(
    () => validateArgs("openai/gpt-image-2/text-to-image", makeArgs({ referenceImages: ["ref.png"] })),
    /Reference images are not supported/,
  );
});

test("Atlas submits once, polls with GET, and downloads the completed image", async (t) => {
  useEnv(t, {
    ATLASCLOUD_API_KEY: "test-key",
    ATLASCLOUD_BASE_URL: "https://atlas.example",
    ATLASCLOUD_POLL_INTERVAL_MS: "0",
    ATLASCLOUD_MAX_POLL_MS: "1000",
  });

  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method || "GET";
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });

    if (url.endsWith("/api/v1/model/generateImage")) {
      return new Response(JSON.stringify({ code: 200, data: { id: "req-1", status: "created" } }));
    }
    if (url.endsWith("/api/v1/model/result/req-1") && calls.filter((call) => call.url === url).length === 1) {
      return new Response(JSON.stringify({ code: 200, data: { id: "req-1", status: "processing" } }));
    }
    if (url.endsWith("/api/v1/model/result/req-1")) {
      return new Response(JSON.stringify({ code: 200, data: { id: "req-1", status: "completed", outputs: ["https://cdn.example/image.png"] } }));
    }
    if (url === "https://cdn.example/image.png") {
      return new Response(Uint8Array.from([137, 80, 78, 71]));
    }
    return new Response("not found", { status: 404 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const image = await generateImage(
    "A studio product photo",
    "openai/gpt-image-2/text-to-image",
    makeArgs({ quality: "normal" }),
  );

  assert.deepEqual([...image], [137, 80, 78, 71]);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(calls.filter((call) => call.url.includes("/model/result/")).length, 2);
  assert.equal(
    (calls[0]?.body as Record<string, unknown>).model,
    "openai/gpt-image-2/text-to-image",
  );
});

test("Atlas output extraction requires a non-empty outputs URL", () => {
  assert.equal(
    extractOutputUrl({ outputs: ["https://example.com/image.png"] }),
    "https://example.com/image.png",
  );
  assert.throws(() => extractOutputUrl({ outputs: [] }), /Unexpected Atlas output format/);
});

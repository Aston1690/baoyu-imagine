import type { CliArgs } from "../types";

const DEFAULT_MODEL = "openai/gpt-image-2/text-to-image";
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_MAX_POLL_MS = 300_000;

type Prediction = {
  id?: string;
  status?: string;
  outputs?: string[];
  error?: string | null;
  message?: string;
};

type AtlasResponse = Prediction & {
  code?: number;
  data?: Prediction;
};

export function getDefaultModel(): string {
  return process.env.ATLAS_IMAGE_MODEL || DEFAULT_MODEL;
}

export function getDefaultOutputExtension(): string {
  return ".png";
}

function getBaseUrl(): string {
  return (process.env.ATLASCLOUD_BASE_URL || "https://api.atlascloud.ai").replace(/\/+$/g, "");
}

function parseAspectRatio(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : null;
}

export function getAtlasSize(args: CliArgs): string {
  if (args.size) return args.size;

  const ratio = parseAspectRatio(args.aspectRatio);
  const highResolution = args.quality === "2k";

  if (ratio !== null && ratio > 1.25) {
    return highResolution ? "2048x1152" : "1024x768";
  }
  if (ratio !== null && ratio < 0.8) {
    return highResolution ? "1152x2048" : "768x1024";
  }
  return highResolution ? "2048x2048" : "1024x1024";
}

export function buildInput(prompt: string, model: string, args: CliArgs): Record<string, unknown> {
  return {
    model,
    prompt,
    size: getAtlasSize(args),
    quality: args.quality === "2k" ? "high" : "medium",
    output_format: "png",
    enable_sync_mode: false,
    enable_base64_output: false,
  };
}

export function validateArgs(_model: string, args: CliArgs): void {
  if (args.referenceImages.length > 0) {
    throw new Error(
      "Reference images are not supported by the Atlas text-to-image provider. Remove --ref or choose a ref-capable provider."
    );
  }
}

function unwrapPrediction(response: AtlasResponse): Prediction {
  if (response.code !== undefined && response.code !== 0 && response.code !== 200) {
    throw new Error(`Atlas API error (${response.code}): ${response.message || "request failed"}`);
  }
  return response.data ?? response;
}

async function readAtlasResponse(response: Response, operation: string): Promise<Prediction> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Atlas ${operation} error (${response.status}): ${text}`);
  }

  let payload: AtlasResponse;
  try {
    payload = JSON.parse(text) as AtlasResponse;
  } catch {
    throw new Error(`Atlas ${operation} returned invalid JSON`);
  }
  return unwrapPrediction(payload);
}

async function createPrediction(
  apiKey: string,
  input: Record<string, unknown>
): Promise<Prediction> {
  const response = await fetch(`${getBaseUrl()}/api/v1/model/generateImage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  return readAtlasResponse(response, "generation");
}

function getPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollPrediction(apiKey: string, requestId: string): Promise<Prediction> {
  const intervalMs = getPositiveInt(process.env.ATLASCLOUD_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS);
  const maxPollMs = getPositiveInt(process.env.ATLASCLOUD_MAX_POLL_MS, DEFAULT_MAX_POLL_MS);
  const startedAt = Date.now();
  let transientFailures = 0;

  while (Date.now() - startedAt <= maxPollMs) {
    const response = await fetch(
      `${getBaseUrl()}/api/v1/model/result/${encodeURIComponent(requestId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );

    if (!response.ok && (response.status === 429 || response.status >= 500)) {
      transientFailures += 1;
      if (transientFailures > 3) {
        const detail = await response.text();
        throw new Error(`Atlas poll error (${response.status}): ${detail}`);
      }
      await sleep(Math.min(intervalMs * 2 ** transientFailures, 8000));
      continue;
    }

    const prediction = await readAtlasResponse(response, "poll");
    const status = prediction.status?.toLowerCase();
    if (status === "completed" || status === "succeeded") return prediction;
    if (status === "failed" || status === "canceled" || status === "cancelled") {
      throw new Error(`Atlas prediction ${status}: ${prediction.error || prediction.message || "unknown error"}`);
    }

    await sleep(intervalMs);
  }

  throw new Error(`Atlas prediction timed out after ${Math.round(maxPollMs / 1000)}s`);
}

export function extractOutputUrl(prediction: Prediction): string {
  const output = prediction.outputs?.[0];
  if (typeof output === "string" && output.length > 0) return output;
  throw new Error("Unexpected Atlas output format: no image URL returned");
}

async function downloadImage(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download image from Atlas: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function generateImage(
  prompt: string,
  model: string,
  args: CliArgs
): Promise<Uint8Array> {
  const apiKey = process.env.ATLASCLOUD_API_KEY;
  if (!apiKey) {
    throw new Error("ATLASCLOUD_API_KEY is required");
  }

  validateArgs(model, args);
  console.log(`Generating image with Atlas Cloud (${model})...`);

  // Creation is intentionally submitted once. Only result polling is retried.
  let prediction = await createPrediction(apiKey, buildInput(prompt, model, args));
  const status = prediction.status?.toLowerCase();
  if (status !== "completed" && status !== "succeeded") {
    if (!prediction.id) throw new Error("Atlas generation did not return a request ID");
    prediction = await pollPrediction(apiKey, prediction.id);
  }

  return downloadImage(extractOutputUrl(prediction));
}

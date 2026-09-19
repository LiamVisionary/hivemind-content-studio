/**
 * Test script for MiniMax provider integration.
 *
 * Verifies that the MiniMax Image 01 model is correctly registered in the one
 * MUAPI catalog (src/hivemind_content_studio/catalog/muapi_models.json, served
 * to the studios at /api/muapi/catalog) and that the model definition has the
 * expected structure.
 *
 * Usage:
 *   node scripts/test_minimax_provider.js
 *
 * Set MUAPI_KEY env var to run the live API smoke test:
 *   MUAPI_KEY=your_key node scripts/test_minimax_provider.js
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── 1. Model registration check ──────────────────────────────────────────────

const CATALOG = join(ROOT, "..", "..", "src", "hivemind_content_studio", "catalog", "muapi_models.json");

let t2iModels;
try {
  t2iModels = JSON.parse(readFileSync(CATALOG, "utf-8")).buckets.t2i;
} catch (err) {
  console.error(`FAIL: could not read the MUAPI catalog at ${CATALOG}:`, err.message);
  process.exit(1);
}

const minimaxModel = t2iModels.find((m) => m.id === "minimax-image-01");

if (!minimaxModel) {
  console.error(
    'FAIL: "minimax-image-01" not found in t2iModels.\n' +
      "Expected it to be registered in the catalog's t2i bucket."
  );
  process.exit(1);
}

// Validate required fields
const required = ["id", "name", "endpoint", "family", "inputs"];
for (const field of required) {
  if (!minimaxModel[field]) {
    console.error(`FAIL: minimax-image-01 is missing required field: ${field}`);
    process.exit(1);
  }
}

if (minimaxModel.family !== "minimax") {
  console.error(
    `FAIL: expected family "minimax", got "${minimaxModel.family}"`
  );
  process.exit(1);
}

if (!minimaxModel.inputs.prompt) {
  console.error("FAIL: minimax-image-01 inputs missing 'prompt' field");
  process.exit(1);
}

if (!minimaxModel.inputs.aspect_ratio?.enum?.includes("1:1")) {
  console.error(
    "FAIL: minimax-image-01 aspect_ratio enum does not include '1:1'"
  );
  process.exit(1);
}

console.log("PASS: minimax-image-01 is correctly registered in t2iModels");
console.log(
  `      endpoint=${minimaxModel.endpoint}  family=${minimaxModel.family}`
);
console.log(
  `      aspect ratios: ${minimaxModel.inputs.aspect_ratio.enum.join(", ")}`
);

// ── 2. Live API smoke test (optional) ────────────────────────────────────────

const apiKey = process.env.MUAPI_KEY;
if (!apiKey) {
  console.log(
    "\nINFO: Skipping live API test (set MUAPI_KEY env var to enable)."
  );
  console.log("\nAll checks passed.");
  process.exit(0);
}

console.log("\nRunning live API smoke test against muapi.ai …");

const MUAPI_BASE = "https://api.muapi.ai";

async function testMiniMaxImageGeneration() {
  const endpoint = minimaxModel.endpoint;
  const url = `${MUAPI_BASE}/api/v1/${endpoint}`;

  const payload = {
    prompt: "A simple test: a red apple on a white background.",
    aspect_ratio: "1:1",
    num_images: 1,
  };

  console.log(`POST ${url}`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`FAIL: API returned ${res.status}: ${text.slice(0, 200)}`);
    process.exit(1);
  }

  const data = await res.json();
  const requestId = data.request_id || data.id;
  if (!requestId) {
    console.error("FAIL: No request_id in response:", JSON.stringify(data));
    process.exit(1);
  }
  console.log(`PASS: Generation queued — request_id=${requestId}`);

  // Poll for result (max 60 s)
  const pollUrl = `${MUAPI_BASE}/api/v1/predictions/${requestId}/result`;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const poll = await fetch(pollUrl, {
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    });
    if (!poll.ok) continue;
    const result = await poll.json();
    const status = result.status?.toLowerCase();
    if (status === "completed" || status === "succeeded" || status === "success") {
      const imageUrl =
        result.outputs?.[0] || result.url || result.output?.url;
      console.log(`PASS: Generation complete — image URL: ${imageUrl}`);
      console.log("\nAll checks passed.");
      return;
    }
    if (status === "failed" || status === "error") {
      console.error("FAIL: Generation failed:", result.error);
      process.exit(1);
    }
    console.log(`      Polling … status=${status}`);
  }
  console.error("FAIL: Timed out waiting for generation result.");
  process.exit(1);
}

testMiniMaxImageGeneration().catch((err) => {
  console.error("FAIL: Unexpected error:", err.message);
  process.exit(1);
});

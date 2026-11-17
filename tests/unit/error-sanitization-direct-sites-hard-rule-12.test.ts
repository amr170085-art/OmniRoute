import "../_setup/disableAdobeBrowser.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Regression guard for Hard Rule #12 — error text returned by these sites must be sanitized
// where it is produced, not only by a later layer (chatCore's parseUpstreamError/buildErrorBody
// or the media routes' toJsonErrorPayload). Each test drives the real code with an error whose
// message carries a stack frame, an absolute path and an API key, and fails when the matching
// sanitizeErrorMessage() call is reverted:
//   - copilot-web.ts: non-streaming and streaming catch blocks of execute()
//   - sessionPool/webExecutorWrapper.ts: pool-exhausted and network-error bodies
//   - Adobe Firefly image, video and upscale handlers: the AdobeFireflyError branch

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-hr12-direct-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const LEAKY = "upstream failed at /srv/app/client.ts:44:15 api_key=sk-1234567890abcdef";

function assertNoLeak(text: string, where: string) {
  assert.ok(!text.includes("at /srv/app/client.ts:44:15"), `${where}: stack frame leaked`);
  assert.ok(!text.includes("/srv/app/"), `${where}: absolute path leaked`);
  assert.ok(!text.includes("sk-1234567890abcdef"), `${where}: api key leaked`);
}

const { CopilotWebExecutor } = await import("../../open-sse/executors/copilot-web.ts");
const { withSessionPool } =
  await import("../../open-sse/services/sessionPool/webExecutorWrapper.ts");
const { AdobeFireflyError } = await import("../../open-sse/services/adobeFireflyCredentials.ts");
const { handleAdobeFireflyImageGeneration } =
  await import("../../open-sse/handlers/imageGeneration/providers/adobeFirefly.ts");
const { handleAdobeFireflyVideoGeneration } =
  await import("../../open-sse/handlers/videoGeneration/adobeFireflyHandler.ts");
const { handleAdobeFireflyImageUpscale } =
  await import("../../open-sse/handlers/imageUpscale/adobeFirefly.ts");
const core = await import("../../src/lib/db/core.ts");
const { waitForCallLogSaves } = await import("../../src/lib/usage/callLogs.ts");

test.after(async () => {
  await waitForCallLogSaves(60_000);
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function copilotWithFailingSocket() {
  const executor = new CopilotWebExecutor() as unknown as Record<string, unknown>;
  executor.getSession = async () => ({ conversationId: "conv-1", cookies: "" });
  executor.wsChat = async () => {
    throw new Error(LEAKY);
  };
  return executor as unknown as InstanceType<typeof CopilotWebExecutor>;
}

for (const stream of [false, true]) {
  test(`copilot-web ${stream ? "streaming" : "non-streaming"} error body is sanitized`, async () => {
    const result = await copilotWithFailingSocket().execute({
      body: { messages: [{ role: "user", content: "hello" }] },
      credentials: { apiKey: `ey${"x".repeat(120)}` },
      model: "copilot",
      stream,
    } as never);

    assert.equal(result.response.status, 502);
    assertNoLeak(await result.response.text(), `copilot-web stream=${stream}`);
  });
}

function fakePool(acquire: () => Promise<unknown>) {
  return {
    provider: "test-provider",
    totalRequests: 0,
    acquireBlocking: acquire,
    reportCooldown() {},
    reportDead() {},
    reportSuccess() {},
  } as never;
}

const fakeSession = {
  id: "s1",
  buildHeaders: (h?: Record<string, string>) => h ?? {},
  release() {},
};

test("webExecutorWrapper network-error body is sanitized", async () => {
  const wrapped = withSessionPool(
    async () => {
      throw new Error(LEAKY);
    },
    fakePool(async () => fakeSession)
  );
  const res = await wrapped({ url: "https://example.test" });
  assert.equal(res.status, 502);
  assertNoLeak(res.body, "webExecutorWrapper network error");
});

test("webExecutorWrapper pool-exhausted body is sanitized", async () => {
  const wrapped = withSessionPool(
    async () => {
      throw new Error("executor must not run");
    },
    fakePool(async () => {
      throw new Error(LEAKY);
    })
  );
  const res = await wrapped({ url: "https://example.test" });
  assert.equal(res.status, 503);
  assertNoLeak(res.body, "webExecutorWrapper pool exhausted");
});

const throwingFetch = (async () => {
  throw new AdobeFireflyError(LEAKY, 500);
}) as unknown as typeof fetch;
const adobeCredentials = { apiKey: `eyJhbGciOiJSUzI1NiJ9.${"a".repeat(60)}.${"b".repeat(40)}` };

test("Adobe Firefly image handler sanitizes AdobeFireflyError text", async () => {
  const result = await handleAdobeFireflyImageGeneration({
    model: "nano-banana-pro",
    provider: "adobe-firefly",
    body: { prompt: "test" },
    credentials: adobeCredentials,
    fetchImpl: throwingFetch,
  });
  assert.equal(result.success, false);
  assertNoLeak(String(result.error), "adobe image");
});

test("Adobe Firefly video handler sanitizes AdobeFireflyError text", async () => {
  const result = await handleAdobeFireflyVideoGeneration({
    model: "sora-2",
    provider: "adobe-firefly",
    body: { prompt: "test" },
    credentials: adobeCredentials,
    fetchImpl: throwingFetch,
  });
  assert.equal(result.success, false);
  assertNoLeak(String(result.error), "adobe video");
});

test("Adobe Firefly upscale handler sanitizes AdobeFireflyError text", async () => {
  const result = await handleAdobeFireflyImageUpscale({
    model: "topaz-standard",
    provider: "adobe-firefly",
    body: {
      image:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
    },
    credentials: adobeCredentials,
    fetchImpl: throwingFetch,
  });
  assert.equal(result.success, false);
  assertNoLeak(String(result.error), "adobe upscale");
});

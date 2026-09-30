// Pure-logic tests for scripts/lib/retry.mjs. No browser, no ffmpeg — the
// transport-error classification and retry loop are exercised on plain
// thrown Errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isTransportError, withTransportRetry } from "../scripts/lib/retry.mjs";

test("isTransportError: recognizes Playwright transport/connection failures", () => {
  assert.ok(isTransportError(new Error("Protocol error (Target.closeTarget): Target closed.")));
  assert.ok(isTransportError(new Error("Target page, context or browser has been closed")));
  assert.ok(isTransportError(new Error("WebSocket error: connection closed")));
  assert.ok(isTransportError(new Error("browser has disconnected (pid 1234)")));
});

test("isTransportError: a real page/application error is not a transport error", () => {
  assert.equal(isTransportError(new Error("no <canvas> found in reel.html")), false);
  assert.equal(isTransportError(new Error("page errors on load: TypeError: x is not a function")), false);
  assert.equal(isTransportError(new Error("A/V duration gate failed: video 3.100s vs audio 3.050s")), false);
  assert.equal(isTransportError(null), false);
});

test("withTransportRetry: succeeds without retrying when fn succeeds first try", async () => {
  let calls = 0;
  const result = await withTransportRetry(async () => {
    calls++;
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("withTransportRetry: retries a transport error up to maxRetries, then succeeds", async () => {
  let calls = 0;
  const retries = [];
  const result = await withTransportRetry(
    async (attempt) => {
      calls++;
      if (attempt < 2) throw new Error("Protocol error: Target closed.");
      return "ok";
    },
    {
      maxRetries: 2,
      onRetry: (attempt, err) => {
        retries.push({ attempt, message: err.message });
      },
    }
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3); // attempts 0, 1, 2
  assert.deepEqual(retries.map((r) => r.attempt), [1, 2]);
});

test("withTransportRetry: does not retry a non-transport error", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withTransportRetry(async () => {
        calls++;
        throw new Error("no <canvas> found in reel.html");
      }),
    /no <canvas> found/
  );
  assert.equal(calls, 1);
});

test("withTransportRetry: gives up and rethrows after maxRetries transport errors", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withTransportRetry(
        async () => {
          calls++;
          throw new Error("Target closed.");
        },
        { maxRetries: 2 }
      ),
    /Target closed/
  );
  assert.equal(calls, 3); // initial attempt + 2 retries
});

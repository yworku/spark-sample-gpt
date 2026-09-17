import assert from "node:assert/strict";
import { test } from "node:test";
import { api } from "../src/api.ts";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

test("a lost enqueue response and expired login retain the paid request identity", async (t) => {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "sessionStorage", {
    value: storage,
    configurable: true,
  });
  const received: string[] = [];
  const ledger = new Map<string, string>();
  let attempt = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options: RequestInit) => {
      const request = JSON.parse(options.body as string);
      received.push(request.idempotency_key);
      attempt++;
      if (attempt === 2)
        return new Response(JSON.stringify({ detail: "Please sign in." }), {
          status: 401,
        });
      if (!ledger.has(request.idempotency_key))
        ledger.set(request.idempotency_key, crypto.randomUUID());
      if (attempt === 1)
        throw new TypeError("Connection closed after the server committed");
      return new Response(
        JSON.stringify({
          id: ledger.get(request.idempotency_key),
          status: "queued",
        }),
        { status: 201 },
      );
    },
  );
  const input = {
    kind: "image",
    base_revision: 1,
    scene_id: crypto.randomUUID(),
  };
  const projectId = crypto.randomUUID();
  await assert.rejects(api.job(projectId, input), /Connection closed/);
  await assert.rejects(api.job(projectId, input), /sign in/);
  const recovered = await api.job(projectId, input);
  assert.equal(new Set(received).size, 1);
  assert.equal(ledger.size, 1);
  const nextTake = await api.job(projectId, input);
  assert.notEqual(nextTake.id, recovered.id);
  assert.equal(ledger.size, 2);
  assert.equal(storage.values.size, 0);
});

test("generation is not sent when its recovery key cannot be persisted", async (t) => {
  const storage = new MemoryStorage();
  storage.setItem = () => {
    throw new Error("storage unavailable");
  };
  Object.defineProperty(globalThis, "sessionStorage", {
    value: storage,
    configurable: true,
  });
  const mocked = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("{}"),
  );
  await assert.rejects(
    api.job(crypto.randomUUID(), { kind: "voice", base_revision: 2 }),
    /request was not sent/,
  );
  assert.equal(mocked.mock.callCount(), 0);
});

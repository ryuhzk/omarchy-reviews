import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AppleClient } from "../backend/apple";
import { dispatch } from "../backend/customer-reviews";
import { showConfig } from "../backend/config";

async function tempDir(name: string): Promise<string> {
  const dir = join(import.meta.dir, "..", ".tmp", `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function writeKey(dir: string): Promise<string> {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const path = join(dir, "source.p8");
  return writeFile(path, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 }).then(() => path);
}

function fakeClient(): AppleClient {
  return {
    listApps: async () => [{ id: "app-1", name: "Brifdo", bundleId: "com.brifdo.app", sku: "B" }],
    listReviews: async (appId) => ({
      reviews: [
        {
          id: "rev-1",
          rating: 5,
          title: "Great",
          body: "Nice app",
          nickname: "Ada",
          createdDate: "2026-09-01T00:00:00Z",
          territory: "USA",
          response: null,
        },
      ],
      next: "",
      appId,
    }),
    createReply: async (reviewId, body) => ({ reviewId, responseId: `resp-${body.length}` }),
    deleteReply: async (responseId) => ({ responseId }),
  };
}

describe("dispatch", () => {
  test("config set copies the key and never echoes the PEM", async () => {
    const configDir = await tempDir("cli-config");
    const cacheDir = await tempDir("cli-cache");
    const keyPath = await writeKey(configDir);
    const result = await dispatch([
      "config", "set", "--issuer", "ISS-1", "--key-id", "KID1", "--key", keyPath,
    ], { configDir, cacheDir });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as ReturnType<typeof showConfig>;
    expect(data.configured).toBe(true);
    expect(data.keyPath).toContain("AuthKey_KID1.p8");
    expect(JSON.stringify(result)).not.toContain("BEGIN PRIVATE KEY");
  });

  test("rejects an empty reply before calling Apple", async () => {
    const configDir = await tempDir("cli-reply");
    const cacheDir = await tempDir("cli-reply-cache");
    const keyPath = await writeKey(configDir);
    await dispatch(["config", "set", "--issuer", "ISS", "--key-id", "KID", "--key", keyPath], { configDir, cacheDir });

    const result = await dispatch(["reviews", "reply", "--review", "rev-1", "--body", "   "], {
      configDir,
      cacheDir,
      createClient: () => fakeClient(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("usage");
  });

  test("lists unreplied reviews through the fake client", async () => {
    const configDir = await tempDir("cli-list");
    const cacheDir = await tempDir("cli-list-cache");
    const keyPath = await writeKey(configDir);
    await dispatch(["config", "set", "--issuer", "ISS", "--key-id", "KID", "--key", keyPath], { configDir, cacheDir });
    await dispatch(["watch", "--ids", "app-1"], { configDir, cacheDir });

    const result = await dispatch(["reviews", "list", "--app", "app-1", "--unreplied"], {
      configDir,
      cacheDir,
      createClient: () => fakeClient(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { reviews: Array<{ id: string }> };
    expect(data.reviews.map((review) => review.id)).toEqual(["rev-1"]);
  });
});

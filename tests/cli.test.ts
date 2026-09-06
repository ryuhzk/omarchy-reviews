import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AppleClient } from "../backend/apple";
import { dispatch } from "../backend/customer-reviews";
import { showConfig } from "../backend/config";
import type { PlayClient } from "../backend/play";
import { PLAY_REPLY_MAX_CHARS } from "../backend/model";

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
    listApps: async () => [{ id: "app-1", name: "Brifdo", bundleId: "com.brifdo.app", sku: "B", store: "apple" }],
    listReviews: async (appId) => ({
      reviews: [
        {
          id: "rev-1",
          store: "apple",
          rating: 5,
          title: "Great",
          body: "Nice app",
          nickname: "Ada",
          createdDate: "2026-09-01T00:00:00Z",
          territory: "USA",
          version: "",
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

  test("lists reviews into sqlite and serves them from cache before a later fetch", async () => {
    const configDir = await tempDir("cli-cache-inbox");
    const cacheDir = await tempDir("cli-cache-inbox-data");
    const keyPath = await writeKey(configDir);
    await dispatch(["config", "set", "--issuer", "ISS", "--key-id", "KID", "--key", keyPath], { configDir, cacheDir });
    await dispatch(["watch", "--ids", "app-1"], { configDir, cacheDir });

    const listed = await dispatch(["reviews", "list", "--app", "app-1"], {
      configDir,
      cacheDir,
      createClient: () => fakeClient(),
    });
    expect(listed.ok).toBe(true);

    const cached = await dispatch(["reviews", "cached", "--app", "app-1"], { configDir, cacheDir });
    expect(cached.ok).toBe(true);
    if (!cached.ok) return;
    const cachedData = cached.data as { reviews: Array<{ id: string; title: string }>; next: string };
    expect(cachedData.reviews.map((review) => review.id)).toEqual(["rev-1"]);
    expect(cachedData.reviews[0]?.title).toBe("Great");

    const shown = await dispatch(["config", "show"], { configDir, cacheDir });
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    const inbox = (shown.data as { inbox: { reviews: Array<{ id: string }> } }).inbox;
    expect(inbox.reviews.map((review) => review.id)).toEqual(["rev-1"]);
  });

  test("config set-play copies the JSON and never echoes the private key", async () => {
    const configDir = await tempDir("cli-play-config");
    const cacheDir = await tempDir("cli-play-cache");
    const keyPath = join(configDir, "play.json");
    await writeFile(keyPath, JSON.stringify({
      client_email: "reviews@proj.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\\nSECRET\\n-----END PRIVATE KEY-----\\n",
    }), { mode: 0o600 });

    const result = await dispatch(["config", "set-play", "--key", keyPath], { configDir, cacheDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as ReturnType<typeof showConfig>;
    expect(data.playConfigured).toBe(true);
    expect(data.configured).toBe(true);
    expect(data.playKeyPath).toContain("play-service-account.json");
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("BEGIN PRIVATE KEY");
  });

  test("lists Play reviews and rejects delete-reply", async () => {
    const configDir = await tempDir("cli-play-list");
    const cacheDir = await tempDir("cli-play-list-cache");
    const keyPath = join(configDir, "play.json");
    await writeFile(keyPath, JSON.stringify({
      client_email: "reviews@proj.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\\nX\\n-----END PRIVATE KEY-----\\n",
    }), { mode: 0o600 });
    await dispatch(["config", "set-play", "--key", keyPath], { configDir, cacheDir });
    await dispatch(["watch", "--ids", "play:com.brifdo.app"], { configDir, cacheDir });

    const playClient: PlayClient = {
      listApps: async () => [{ id: "play:com.brifdo.app", name: "Brifdo", bundleId: "com.brifdo.app", sku: "", store: "play" }],
      listReviews: async () => ({
        reviews: [{
          id: "gp-1",
          store: "play",
          rating: 4,
          title: "Lag",
          body: "Fix it",
          nickname: "Sam",
          createdDate: "2026-09-01T00:00:00Z",
          territory: "en",
          version: "2.0.0",
          response: null,
        }],
        next: "",
      }),
      createReply: async (_packageName, reviewId) => ({ reviewId, responseId: `play:${reviewId}` }),
    };

    const listed = await dispatch(["reviews", "list", "--app", "play:com.brifdo.app"], {
      configDir,
      cacheDir,
      createPlayClient: () => playClient,
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const data = listed.data as { reviews: Array<{ store: string; version: string }> };
    expect(data.reviews[0]?.store).toBe("play");
    expect(data.reviews[0]?.version).toBe("2.0.0");

    const deleted = await dispatch(["reviews", "delete-reply", "--response", "play:gp-1", "--app", "play:com.brifdo.app"], {
      configDir,
      cacheDir,
      createPlayClient: () => playClient,
    });
    expect(deleted.ok).toBe(false);
    if (deleted.ok) return;
    expect(deleted.error.code).toBe("usage");

    const oversized = await dispatch(["reviews", "reply", "--review", "gp-1", "--body", "x".repeat(PLAY_REPLY_MAX_CHARS + 1), "--app", "play:com.brifdo.app"], {
      configDir,
      cacheDir,
      createPlayClient: () => playClient,
    });
    expect(oversized.ok).toBe(false);
    if (oversized.ok) return;
    expect(oversized.error.code).toBe("usage");
  });
});

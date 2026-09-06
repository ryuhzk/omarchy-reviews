import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { saveConfig } from "../backend/config";
import type { AppInfo, Review } from "../backend/model";
import { listCachedInbox } from "../backend/inbox-db";
import { runPoll } from "../backend/store";

async function tempDir(name: string): Promise<string> {
  const dir = join(import.meta.dir, "..", ".tmp", `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function review(id: string, extras: Partial<Review> = {}): Review {
  return {
    id,
    store: "apple",
    rating: 5,
    title: `Title ${id}`,
    body: `Body ${id}`,
    nickname: "Pat",
    createdDate: "2026-09-01T00:00:00Z",
    territory: "USA",
    version: "",
    response: null,
    ...extras,
  };
}

describe("runPoll", () => {
  test("returns empty newReviews on first seed and only unseen ids later", async () => {
    const configDir = await tempDir("poll-config");
    const cacheDir = await tempDir("poll-cache");
    const keyPath = join(configDir, "key.p8");
    await Bun.write(keyPath, "pem\n");
    await saveConfig(configDir, {
      issuerId: "ISS",
      keyId: "KID",
      privateKeyPath: keyPath,
      watchedAppIds: ["app-1"],
      activeAppId: "app-1",
    });

    const apps: AppInfo[] = [{ id: "app-1", name: "Brifdo", bundleId: "com.brifdo.app", sku: "B", store: "apple" }];
    let reviews = [review("rev-1"), review("rev-2", { rating: 1, title: "Bad" })];

    const first = await runPoll({
      configDir,
      cacheDir,
      fetchApps: async () => apps,
      fetchReviews: async () => ({ reviews, next: "" }),
    });
    expect(first.configured).toBe(true);
    expect(first.unrepliedCount).toBe(2);
    expect(first.newReviews).toEqual([]);
    expect(listCachedInbox(cacheDir, "app-1").reviews.map((item) => item.id).sort()).toEqual(["rev-1", "rev-2"]);

    reviews = [review("rev-1"), review("rev-2"), review("rev-3", { title: "New one" })];
    const second = await runPoll({
      configDir,
      cacheDir,
      fetchApps: async () => apps,
      fetchReviews: async () => ({ reviews, next: "" }),
    });
    expect(second.newReviews.map((item) => item.reviewId)).toEqual(["rev-3"]);
    expect(second.newReviews[0]?.appName).toBe("Brifdo");
    expect(second.unrepliedCount).toBe(3);
  });

  test("does not mark reviews seen when one app fetch fails", async () => {
    const configDir = await tempDir("poll-fail-config");
    const cacheDir = await tempDir("poll-fail-cache");
    const keyPath = join(configDir, "key.p8");
    await Bun.write(keyPath, "pem\n");
    await saveConfig(configDir, {
      issuerId: "ISS",
      keyId: "KID",
      privateKeyPath: keyPath,
      watchedAppIds: ["app-ok", "app-bad"],
      activeAppId: "app-ok",
    });

    const first = await runPoll({
      configDir,
      cacheDir,
      fetchApps: async () => [
        { id: "app-ok", name: "Ok", bundleId: "ok", sku: "OK", store: "apple" },
        { id: "app-bad", name: "Bad", bundleId: "bad", sku: "BAD", store: "apple" },
      ],
      fetchReviews: async (appId) => {
        if (appId === "app-bad") throw new Error("boom");
        return { reviews: [review("ok-1")], next: "" };
      },
    });
    expect(first.unrepliedCount).toBe(1);
    expect(first.newReviews).toEqual([]);

    const second = await runPoll({
      configDir,
      cacheDir,
      fetchApps: async () => [
        { id: "app-ok", name: "Ok", bundleId: "ok", sku: "OK", store: "apple" },
        { id: "app-bad", name: "Bad", bundleId: "bad", sku: "BAD", store: "apple" },
      ],
      fetchReviews: async (appId) => {
        if (appId === "app-bad") return { reviews: [review("bad-1")], next: "" };
        return { reviews: [review("ok-1")], next: "" };
      },
    });
    expect(second.newReviews.map((item) => item.reviewId)).toEqual([]);
    expect(second.unrepliedCount).toBe(2);
  });

  test("returns configured false without fetching when credentials are missing", async () => {
    const configDir = await tempDir("poll-empty-config");
    const cacheDir = await tempDir("poll-empty-cache");
    let fetched = false;
    const result = await runPoll({
      configDir,
      cacheDir,
      fetchApps: async () => {
        fetched = true;
        return [];
      },
      fetchReviews: async () => {
        fetched = true;
        return { reviews: [], next: "" };
      },
    });
    expect(result).toEqual({ configured: false, unrepliedCount: 0, newReviews: [] });
    expect(fetched).toBe(false);
  });

  test("returns every unseen review in JSON when more than five arrive", async () => {
    const configDir = await tempDir("poll-digest-config");
    const cacheDir = await tempDir("poll-digest-cache");
    const keyPath = join(configDir, "key.p8");
    await Bun.write(keyPath, "pem\n");
    await saveConfig(configDir, {
      issuerId: "ISS",
      keyId: "KID",
      privateKeyPath: keyPath,
      watchedAppIds: ["app-1"],
      activeAppId: "app-1",
    });
    const apps: AppInfo[] = [{ id: "app-1", name: "App", bundleId: "app", sku: "A", store: "apple" }];

    await runPoll({
      configDir,
      cacheDir,
      fetchApps: async () => apps,
      fetchReviews: async () => ({ reviews: [review("seed")], next: "" }),
    });
    const later = await runPoll({
      configDir,
      cacheDir,
      fetchApps: async () => apps,
      fetchReviews: async () => ({
        reviews: [review("seed"), ...["a", "b", "c", "d", "e", "f"].map((id) => review(id))],
        next: "",
      }),
    });
    expect(later.newReviews.map((item) => item.reviewId)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
});

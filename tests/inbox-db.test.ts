import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { clearCachedReply, listCachedInbox, patchCachedReply, rememberReviews } from "../backend/inbox-db";
import type { Review } from "../backend/model";

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

describe("inbox sqlite", () => {
  test("round-trips a page and keeps older reviews when a newer page arrives", async () => {
    const cacheDir = await tempDir("inbox-remember");
    const first = rememberReviews(cacheDir, "app-1", [review("rev-old", { createdDate: "2026-08-01T00:00:00Z" })], "next-1");
    expect(first.reviews.map((item) => item.id)).toEqual(["rev-old"]);
    expect(first.next).toBe("next-1");

    const second = rememberReviews(cacheDir, "app-1", [
      review("rev-new", { createdDate: "2026-09-02T00:00:00Z", title: "Fresh" }),
    ], "next-2");
    expect(second.reviews.map((item) => item.id)).toEqual(["rev-new", "rev-old"]);
    expect(second.next).toBe("next-2");
    expect(second.fetchedAt).not.toBe("");
  });

  test("updates a published reply and can clear it by response id", async () => {
    const cacheDir = await tempDir("inbox-reply");
    rememberReviews(cacheDir, "app-1", [review("rev-1")], "");
    expect(patchCachedReply(cacheDir, "rev-1", {
      id: "resp-9",
      body: "Thanks",
      lastModifiedDate: "2026-09-06T00:00:00Z",
      state: "PUBLISHED",
    })).toBe(true);

    const published = listCachedInbox(cacheDir, "app-1");
    expect(published.reviews[0]?.response).toEqual({
      id: "resp-9",
      body: "Thanks",
      lastModifiedDate: "2026-09-06T00:00:00Z",
      state: "PUBLISHED",
    });

    expect(clearCachedReply(cacheDir, "resp-9")).toBe(true);
    expect(listCachedInbox(cacheDir, "app-1").reviews[0]?.response).toBeNull();
  });

  test("persists store and version for a Play review", async () => {
    const cacheDir = await tempDir("inbox-play");
    rememberReviews(cacheDir, "play:com.brifdo.app", [
      review("gp-1", { store: "play", version: "2.0.0", territory: "en" }),
    ], "");
    const cached = listCachedInbox(cacheDir, "play:com.brifdo.app");
    expect(cached.reviews[0]?.store).toBe("play");
    expect(cached.reviews[0]?.version).toBe("2.0.0");
  });
});

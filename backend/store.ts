import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isConfigured, loadConfig } from "./config";
import { rememberReviews } from "./inbox-db";
import type { AppInfo, NewReview, PollResult, Review, ReviewList } from "./model";

export interface PollDeps {
  configDir: string;
  cacheDir: string;
  fetchApps: () => Promise<AppInfo[]>;
  fetchReviews: (appId: string) => Promise<Omit<ReviewList, "appId">>;
}

export async function runPoll(deps: PollDeps): Promise<PollResult> {
  const config = loadConfig(deps.configDir);
  if (!isConfigured(config) || config.watchedAppIds.length === 0) {
    return { configured: isConfigured(config), unrepliedCount: 0, newReviews: [] };
  }

  mkdirSync(deps.cacheDir, { recursive: true, mode: 0o700 });
  const seen = loadStringSet(deps.cacheDir, "seen.json");
  const seededApps = loadStringSet(deps.cacheDir, "seeded-apps.json");
  const apps = await deps.fetchApps();
  writeJson(join(deps.cacheDir, "apps.json"), apps);

  let unrepliedCount = 0;
  const newReviews: NewReview[] = [];

  for (const appId of config.watchedAppIds) {
    try {
      const page = await deps.fetchReviews(appId);
      rememberReviews(deps.cacheDir, appId, page.reviews, page.next);
      const appName = apps.find((app) => app.id === appId)?.name || appId;
      const alreadySeeded = seededApps.has(appId);
      for (const review of page.reviews) {
        if (!review.response) unrepliedCount += 1;
        if (!seen.has(review.id)) {
          if (alreadySeeded) newReviews.push(toNewReview(appId, appName, review));
          seen.add(review.id);
        }
      }
      seededApps.add(appId);
    } catch {
      // Leave this app unseeded so the first successful fetch does not notify.
    }
  }

  writeJson(join(deps.cacheDir, "seen.json"), [...seen]);
  writeJson(join(deps.cacheDir, "seeded-apps.json"), [...seededApps]);

  return { configured: true, unrepliedCount, newReviews };
}

export function writeCachedApps(cacheDir: string, apps: AppInfo[]): void {
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  writeJson(join(cacheDir, "apps.json"), apps);
}

export function readCachedApps(cacheDir: string): AppInfo[] {
  const path = join(cacheDir, "apps.json");
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.flatMap((item) => {
      if (!item || typeof item !== "object" || typeof (item as AppInfo).id !== "string") return [];
      const app = item as AppInfo;
      const store = app.store === "play" || String(app.id).startsWith("play:") ? "play" as const : "apple" as const;
      return [{
        id: app.id,
        name: String(app.name || app.id),
        bundleId: String(app.bundleId || ""),
        sku: String(app.sku || ""),
        store,
      }];
    }) : [];
  } catch {
    return [];
  }
}

export function markReviewsSeen(cacheDir: string, reviews: Review[]): void {
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const seen = loadStringSet(cacheDir, "seen.json");
  for (const review of reviews) seen.add(review.id);
  writeJson(join(cacheDir, "seen.json"), [...seen]);
}

function toNewReview(appId: string, appName: string, review: Review): NewReview {
  return {
    appId,
    appName,
    reviewId: review.id,
    rating: review.rating,
    title: review.title,
    body: review.body,
  };
}

function loadStringSet(cacheDir: string, name: string): Set<string> {
  const path = join(cacheDir, name);
  if (!existsSync(path)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function writeJson(path: string, value: unknown): void {
  const tempPath = `${path}.${process.pid}`;
  writeFileSync(tempPath, JSON.stringify(value));
  renameSync(tempPath, path);
}

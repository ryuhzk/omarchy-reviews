import type { AppInfo } from "./model";
import { parseAppRef } from "./model";

export interface AppGroup {
  id: string;
  name: string;
  members: AppInfo[];
}

const GENERIC_SEGMENTS = new Set(["app", "ios", "android", "mobile", "free", "lite", "pro"]);

export function lastBundleSegment(app: AppInfo): string {
  const bundle = String(app.bundleId || "").trim() || parseAppRef(app.id).id;
  const parts = bundle.split(".");
  return String(parts[parts.length - 1] || "").trim().toLowerCase();
}

export function appFamilyKeys(app: AppInfo): string[] {
  const keys: string[] = [];
  const name = String(app.name || "").trim().toLowerCase();
  const segment = lastBundleSegment(app);
  if (name !== "" && !name.includes(".")) keys.push(`n:${name}`);
  if (segment !== "" && !GENERIC_SEGMENTS.has(segment) && segment.length >= 2) keys.push(`s:${segment}`);
  if (keys.length === 0) keys.push(`i:${app.id}`);
  return keys;
}

export function groupApps(apps: AppInfo[]): AppGroup[] {
  const list = apps.filter((app) => Boolean(app && app.id));
  const parent = list.map((_, index) => index);
  const find = (index: number): number => {
    if (parent[index] !== index) parent[index] = find(parent[index] ?? index);
    return parent[index] ?? index;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[leftRoot] = rightRoot;
  };

  const owner = new Map<string, number>();
  list.forEach((app, index) => {
    for (const key of appFamilyKeys(app)) {
      const previous = owner.get(key);
      if (previous === undefined) owner.set(key, index);
      else union(previous, index);
    }
  });

  const buckets = new Map<number, AppInfo[]>();
  list.forEach((app, index) => {
    const root = find(index);
    const bucket = buckets.get(root) ?? [];
    bucket.push(app);
    buckets.set(root, bucket);
  });

  return [...buckets.values()].map((members) => {
    const ordered = [...members].sort((left, right) => {
      if (left.store !== right.store) return left.store === "apple" ? -1 : 1;
      return String(left.name || "").localeCompare(String(right.name || ""));
    });
    const named = ordered.find((item) => item.name && !item.name.includes("."))?.name
      || ordered[0]?.name
      || ordered[0]?.id
      || "";
    return {
      id: ordered.map((item) => item.id).join(","),
      name: named,
      members: ordered,
    };
  });
}

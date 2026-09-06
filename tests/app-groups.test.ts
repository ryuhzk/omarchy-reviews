import { describe, expect, test } from "bun:test";
import { groupApps } from "../backend/app-groups";
import type { AppInfo } from "../backend/model";

function app(id: string, extras: Partial<AppInfo> = {}): AppInfo {
  return {
    id,
    name: extras.name ?? id,
    bundleId: extras.bundleId ?? id,
    sku: extras.sku ?? "",
    store: extras.store ?? (id.startsWith("play:") ? "play" : "apple"),
    ...extras,
  };
}

describe("groupApps", () => {
  test("keeps a single-store app as its own row", () => {
    const groups = groupApps([
      app("app-1", { name: "Muqun", bundleId: "dev.osuki.muqun", store: "apple" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBe("Muqun");
    expect(groups[0]?.members.map((item) => item.id)).toEqual(["app-1"]);
  });

  test("groups the same product across App Store and Play by name", () => {
    const groups = groupApps([
      app("app-1", { name: "Muqun", bundleId: "dev.osuki.muqun", store: "apple" }),
      app("play:dev.osuki.muqun", { name: "Muqun", bundleId: "dev.osuki.muqun", store: "play" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBe("Muqun");
    expect(groups[0]?.members.map((item) => item.store)).toEqual(["apple", "play"]);
  });

  test("groups a Play package stub with the Apple app by bundle tail", () => {
    const groups = groupApps([
      app("app-1", { name: "Muqun", bundleId: "dev.osuki.muqun", store: "apple" }),
      app("play:com.osuki.muqun", { name: "com.osuki.muqun", bundleId: "com.osuki.muqun", store: "play" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((item) => item.id)).toEqual(["app-1", "play:com.osuki.muqun"]);
  });

  test("does not group different products that share a generic .app tail", () => {
    const groups = groupApps([
      app("app-a", { name: "小小能手", bundleId: "com.LittleAce.app", store: "apple" }),
      app("app-b", { name: "Other", bundleId: "dev.other.app", store: "apple" }),
    ]);
    expect(groups).toHaveLength(2);
  });
});

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { isConfigured, loadConfig, saveConfig, showConfig } from "../backend/config";

async function tempDir(name: string): Promise<string> {
  const dir = join(import.meta.dir, "..", ".tmp", `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

describe("config", () => {
  test("round-trips settings and reports configured when the key file exists", async () => {
    const dir = await tempDir("config");
    const keyPath = join(dir, "AuthKey_ABC123.p8");
    await writeFile(keyPath, "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n", { mode: 0o600 });

    const saved = await saveConfig(dir, {
      issuerId: "ISSUER-1",
      keyId: "ABC123",
      privateKeyPath: keyPath,
      watchedAppIds: ["app-1", "app-2"],
      activeAppId: "app-1",
    });

    expect(saved.issuerId).toBe("ISSUER-1");
    expect(loadConfig(dir).watchedAppIds).toEqual(["app-1", "app-2"]);

    const shown = showConfig(dir);
    expect(shown.configured).toBe(true);
    expect(shown.keyId).toBe("ABC123");
    expect(shown.keyPath).toBe(keyPath);
    expect(shown.keyPathExists).toBe(true);
    expect(JSON.stringify(shown)).not.toContain("BEGIN PRIVATE KEY");
    expect(isConfigured(loadConfig(dir))).toBe(true);
  });

  test("writes config.env as 0600 and the directory as 0700", async () => {
    const dir = await tempDir("modes");
    const keyPath = join(dir, "key.p8");
    await writeFile(keyPath, "pem\n", { mode: 0o600 });
    await saveConfig(dir, {
      issuerId: "ISS",
      keyId: "KID",
      privateKeyPath: keyPath,
      watchedAppIds: [],
      activeAppId: "",
    });

    const configStat = await Bun.file(join(dir, "config.env")).stat();
    const dirStat = await Bun.file(dir).stat();
    expect(configStat.mode & 0o777).toBe(0o600);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  test("is not configured when the key file is missing", async () => {
    const dir = await tempDir("missing-key");
    await saveConfig(dir, {
      issuerId: "ISS",
      keyId: "KID",
      privateKeyPath: join(dir, "missing.p8"),
      watchedAppIds: ["app-1"],
      activeAppId: "app-1",
    });

    const shown = showConfig(dir);
    expect(shown.configured).toBe(false);
    expect(shown.keyPathExists).toBe(false);
    expect(isConfigured(loadConfig(dir))).toBe(false);
  });

  test("merges patches without dropping the existing key path", async () => {
    const dir = await tempDir("patch");
    const keyPath = join(dir, "key.p8");
    await writeFile(keyPath, "pem\n", { mode: 0o600 });
    await saveConfig(dir, {
      issuerId: "ISS",
      keyId: "KID",
      privateKeyPath: keyPath,
      watchedAppIds: [],
      activeAppId: "",
    });
    await saveConfig(dir, { watchedAppIds: ["app-9"], activeAppId: "app-9" });

    const loaded = loadConfig(dir);
    expect(loaded.privateKeyPath).toBe(keyPath);
    expect(loaded.watchedAppIds).toEqual(["app-9"]);
    expect(loaded.issuerId).toBe("ISS");
  });

  test("ignores an unreadable leftover temp file after a successful save", async () => {
    const dir = await tempDir("empty");
    expect(loadConfig(dir).issuerId).toBe("");
    expect(showConfig(dir).configured).toBe(false);
    await chmod(dir, 0o700);
  });
});

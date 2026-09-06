import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfigShow, PluginConfig } from "./model";

const CONFIG_FILE = "config.env";

export function configFilePath(dir: string): string {
  return join(dir, CONFIG_FILE);
}

export function emptyConfig(): PluginConfig {
  return {
    issuerId: "",
    keyId: "",
    privateKeyPath: "",
    watchedAppIds: [],
    activeAppId: "",
  };
}

export function isConfigured(config: PluginConfig): boolean {
  return config.issuerId !== "" && config.keyId !== "" && config.privateKeyPath !== ""
    && existsSync(config.privateKeyPath);
}

export function loadConfig(dir: string): PluginConfig {
  const path = configFilePath(dir);
  if (!existsSync(path)) return emptyConfig();

  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2] ?? "";
    if (value.length >= 2 && (value[0] === "\"" || value[0] === "'") && value[0] === value[value.length - 1]) {
      value = value.slice(1, -1);
    }
    values[match[1] ?? ""] = value;
  }

  return {
    issuerId: values.ASC_ISSUER_ID ?? "",
    keyId: values.ASC_KEY_ID ?? "",
    privateKeyPath: values.ASC_PRIVATE_KEY_PATH ?? "",
    watchedAppIds: parseIdList(values.WATCHED_APP_IDS ?? ""),
    activeAppId: values.ACTIVE_APP_ID ?? "",
  };
}

export function showConfig(dir: string): ConfigShow {
  const config = loadConfig(dir);
  return {
    configured: isConfigured(config),
    issuerId: config.issuerId,
    keyId: config.keyId,
    keyPath: config.privateKeyPath,
    keyPathExists: config.privateKeyPath !== "" && existsSync(config.privateKeyPath),
    watchedAppIds: config.watchedAppIds,
    activeAppId: config.activeAppId,
  };
}

export async function saveConfig(dir: string, patch: Partial<PluginConfig>): Promise<PluginConfig> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  const next = { ...loadConfig(dir), ...stripUndefined(patch) };
  const body = [
    `ASC_ISSUER_ID=${next.issuerId}`,
    `ASC_KEY_ID=${next.keyId}`,
    `ASC_PRIVATE_KEY_PATH=${next.privateKeyPath}`,
    `WATCHED_APP_IDS=${next.watchedAppIds.join(",")}`,
    `ACTIVE_APP_ID=${next.activeAppId}`,
    "",
  ].join("\n");

  const tempPath = join(dir, `config.env.${process.pid}.${Date.now()}`);
  writeFileSync(tempPath, body, { encoding: "utf8", mode: 0o600 });
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, configFilePath(dir));
  chmodSync(configFilePath(dir), 0o600);
  return next;
}

function parseIdList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter((item) => item !== "");
}

function stripUndefined(patch: Partial<PluginConfig>): Partial<PluginConfig> {
  const next: Partial<PluginConfig> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

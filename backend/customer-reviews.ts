#!/usr/bin/env bun

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { appleError, createAppleClient, validateReplyBody } from "./apple";
import { isConfigured, loadConfig, saveConfig, showConfig } from "./config";
import type { AppleClient } from "./apple";
import type { Envelope, PluginConfig } from "./model";
import { fail, ok } from "./model";
import { defaultCacheDir, defaultConfigDir } from "./paths";
import { markReviewsSeen, readCachedApps, runPoll, writeCachedApps } from "./store";

export interface CliDeps {
  configDir: string;
  cacheDir: string;
  createClient?: (config: PluginConfig, pem: string) => AppleClient;
}

interface ParsedArgs {
  command: string[];
  flags: Record<string, string | boolean>;
  compact: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let compact = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--compact") {
      compact = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      command.push("help");
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[index + 1];
      if (value && !value.startsWith("--")) {
        flags[key] = value;
        index += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }
    command.push(arg);
  }
  return { command, flags, compact };
}

export async function dispatch(argv: string[], deps: CliDeps): Promise<Envelope<unknown>> {
  const parsed = parseArgs(argv);
  const [group, action] = parsed.command;
  const flag = (name: string) => String(parsed.flags[name] || "");

  try {
    if (group === "help" || parsed.command.length === 0) return ok({ usage: usage() });
    if (group === "config" && (action === "show" || action === undefined)) {
      return ok({ ...showConfig(deps.configDir), apps: readCachedApps(deps.cacheDir) });
    }
    if (group === "config" && action === "set") return await setConfig(deps, flag("issuer"), flag("key-id"), flag("key"));
    if (group === "apps") return await listApps(deps);
    if (group === "watch") return ok(await watchApps(deps, flag("ids")));
    if (group === "reviews" && action === "list") return await listReviews(deps, flag("app"), parsed.flags.unreplied === true, flag("next"));
    if (group === "reviews" && action === "reply") return await reply(deps, flag("review"), flag("body"));
    if (group === "reviews" && action === "delete-reply") return await deleteReply(deps, flag("response"));
    if (group === "poll") return await poll(deps);
    return fail("usage", usage());
  } catch (error) {
    if (error && typeof error === "object" && "ok" in error) return error as Envelope<unknown>;
    return appleError(error);
  }
}

function usage(): string {
  return `Usage: customer-reviews <command>

  config show
  config set --issuer <id> --key-id <kid> --key <path>
  apps
  watch --ids <id,id>
  reviews list --app <id> [--unreplied] [--next <url>]
  reviews reply --review <id> --body <text>
  reviews delete-reply --response <id>
  poll
`;
}

async function setConfig(deps: CliDeps, issuerId: string, keyId: string, keyPath: string) {
  if (!issuerId || !keyId || !keyPath) {
    return fail("usage", "config set requires --issuer, --key-id, and --key");
  }
  const source = resolve(keyPath.replace(/^file:\/\//, ""));
  if (!existsSync(source)) return fail("config", "Private key file is missing or unreadable");
  mkdirSync(deps.configDir, { recursive: true, mode: 0o700 });
  chmodSync(deps.configDir, 0o700);
  const dest = join(deps.configDir, `AuthKey_${keyId}.p8`);
  if (source !== dest) copyFileSync(source, dest);
  chmodSync(dest, 0o600);
  await saveConfig(deps.configDir, { issuerId, keyId, privateKeyPath: dest });
  return ok(showConfig(deps.configDir));
}

async function watchApps(deps: CliDeps, ids: string) {
  const watchedAppIds = ids.split(",").map((id) => id.trim()).filter((id) => id !== "");
  const current = loadConfig(deps.configDir);
  const activeAppId = watchedAppIds.includes(current.activeAppId)
    ? current.activeAppId
    : (watchedAppIds[0] ?? "");
  await saveConfig(deps.configDir, { watchedAppIds, activeAppId });
  return { watchedAppIds, activeAppId };
}

async function listApps(deps: CliDeps) {
  const client = clientFor(deps);
  const apps = await client.listApps();
  writeCachedApps(deps.cacheDir, apps);
  return ok({ apps });
}

async function listReviews(deps: CliDeps, appId: string, unrepliedOnly: boolean, nextUrl: string) {
  if (!appId) return fail("usage", "reviews list requires --app");
  const client = clientFor(deps);
  const page = await client.listReviews(appId, nextUrl || undefined);
  await saveConfig(deps.configDir, { activeAppId: appId });
  markReviewsSeen(deps.cacheDir, page.reviews);
  const reviews = unrepliedOnly ? page.reviews.filter((review) => review.response === null) : page.reviews;
  return ok({ appId, reviews, next: page.next });
}

async function reply(deps: CliDeps, reviewId: string, body: string) {
  if (!reviewId) return fail("usage", "reviews reply requires --review");
  const valid = validateReplyBody(body);
  if (!valid.ok) return fail("usage", valid.message);
  const client = clientFor(deps);
  return ok(await client.createReply(reviewId, valid.body));
}

async function deleteReply(deps: CliDeps, responseId: string) {
  if (!responseId) return fail("usage", "reviews delete-reply requires --response");
  const client = clientFor(deps);
  return ok(await client.deleteReply(responseId));
}

async function poll(deps: CliDeps) {
  const config = loadConfig(deps.configDir);
  if (!isConfigured(config)) return ok({ configured: false, unrepliedCount: 0, newReviews: [] });
  const client = clientFor(deps);
  return ok(await runPoll({
    configDir: deps.configDir,
    cacheDir: deps.cacheDir,
    fetchApps: () => client.listApps(),
    fetchReviews: (appId) => client.listReviews(appId),
  }));
}

function clientFor(deps: CliDeps): AppleClient {
  const config = loadConfig(deps.configDir);
  if (!isConfigured(config)) {
    throw fail("config", "App Store Connect is not configured");
  }
  const pem = readFileSync(config.privateKeyPath, "utf8");
  if (deps.createClient) return deps.createClient(config, pem);
  return createAppleClient({ issuerId: config.issuerId, keyId: config.keyId, pem });
}

function printEnvelope(envelope: Envelope<unknown>, compact: boolean): void {
  process.stdout.write(`${JSON.stringify(envelope, null, compact ? 0 : 2)}\n`);
}

if (import.meta.main) {
  const parsed = parseArgs(process.argv.slice(2));
  const envelope = await dispatch(process.argv.slice(2), {
    configDir: defaultConfigDir(),
    cacheDir: defaultCacheDir(),
  });
  printEnvelope(envelope, parsed.compact);
  if (envelope.ok) process.exitCode = 0;
  else process.exitCode = envelope.error.code === "usage" ? 2 : 1;
}

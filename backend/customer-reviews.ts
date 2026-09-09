#!/usr/bin/env bun

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { appleError, createAppleClient, validateReplyBody } from "./apple";
import type { AppleClient } from "./apple";
import { groupApps } from "./app-groups";
import { isAppleConfigured, isConfigured, isPlayConfigured, loadConfig, saveConfig, showConfig } from "./config";
import { clearCachedReply, findCachedReview, listCachedInbox, patchCachedReply, rememberReviews } from "./inbox-db";
import type { AppInfo, Envelope, PluginConfig } from "./model";
import { serializeCliJson } from "./http-limit";
import { fail, ok, parseAppRef } from "./model";
import { defaultCacheDir, defaultConfigDir } from "./paths";
import { createPlayClient, parsePlayServiceAccount, playError, validatePlayReplyBody } from "./play";
import type { PlayClient } from "./play";
import { markReviewsSeen, readCachedApps, runPoll, writeCachedApps } from "./store";

export interface CliDeps {
  configDir: string;
  cacheDir: string;
  createClient?: (config: PluginConfig, pem: string) => AppleClient;
  createPlayClient?: (config: PluginConfig, json: string) => PlayClient;
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
      const shown = showConfig(deps.configDir);
      const apps = readCachedApps(deps.cacheDir);
      return ok({
        ...shown,
        apps,
        groups: groupApps(apps),
        inbox: listCachedInbox(deps.cacheDir, shown.activeAppId),
      });
    }
    if (group === "config" && action === "set") return await setConfig(deps, flag("issuer"), flag("key-id"), flag("key"));
    if (group === "config" && action === "set-play") return await setPlayConfig(deps, flag("key"));
    if (group === "apps") return await listApps(deps);
    if (group === "watch") return ok(await watchApps(deps, flag("ids")));
    if (group === "reviews" && action === "list") return await listReviews(deps, flag("app"), parsed.flags.unreplied === true, flag("next"));
    if (group === "reviews" && action === "cached") return ok(listCachedInbox(deps.cacheDir, flag("app")));
    if (group === "reviews" && action === "reply") return await reply(deps, flag("review"), flag("body"), flag("app"));
    if (group === "reviews" && action === "delete-reply") return await deleteReply(deps, flag("response"), flag("app"));
    if (group === "poll") return await poll(deps);
    return fail("usage", usage());
  } catch (error) {
    return commandError(error);
  }
}

function usage(): string {
  return `Usage: customer-reviews <command>

  config show
  config set --issuer <id> --key-id <kid> --key <path>
  config set-play --key <service-account.json>
  apps
  watch --ids <id,id>
  reviews list --app <id> [--unreplied] [--next <cursor>]
  reviews cached --app <id>
  reviews reply --review <id> --body <text> [--app <id>]
  reviews delete-reply --response <id> [--app <id>]
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

async function setPlayConfig(deps: CliDeps, keyPath: string) {
  if (!keyPath) return fail("usage", "config set-play requires --key");
  const source = resolve(keyPath.replace(/^file:\/\//, ""));
  if (!existsSync(source)) return fail("config", "Play service account file is missing or unreadable");
  const raw = readFileSync(source, "utf8");
  parsePlayServiceAccount(raw);
  mkdirSync(deps.configDir, { recursive: true, mode: 0o700 });
  chmodSync(deps.configDir, 0o700);
  const dest = join(deps.configDir, "play-service-account.json");
  if (source !== dest) copyFileSync(source, dest);
  chmodSync(dest, 0o600);
  await saveConfig(deps.configDir, { playServiceAccountPath: dest });
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
  const config = loadConfig(deps.configDir);
  if (!isConfigured(config)) return fail("config", "Add an App Store Connect API key or a Google Play service account");
  const previous = readCachedApps(deps.cacheDir);
  const apps: AppInfo[] = [];

  if (isAppleConfigured(config)) {
    try {
      apps.push(...await appleClientFor(deps).listApps());
    } catch (error) {
      if (!isPlayConfigured(config)) throw error;
      apps.push(...previous.filter((app) => parseAppRef(app.id).store === "apple"));
    }
  }

  if (isPlayConfigured(config)) {
    try {
      const playApps = await playClientFor(deps).listApps();
      apps.push(...mergePlayApps(playApps, config.watchedAppIds));
    } catch {
      const cachedPlay = previous.filter((app) => parseAppRef(app.id).store === "play");
      apps.push(...(cachedPlay.length > 0 ? cachedPlay : playStubsFromWatched(config.watchedAppIds)));
    }
  }

  writeCachedApps(deps.cacheDir, apps);
  return ok({ apps, groups: groupApps(apps) });
}

async function listReviews(deps: CliDeps, appId: string, unrepliedOnly: boolean, nextCursor: string) {
  if (!appId) return fail("usage", "reviews list requires --app");
  const page = await fetchReviewPage(deps, appId, nextCursor);
  await saveConfig(deps.configDir, { activeAppId: appId });
  markReviewsSeen(deps.cacheDir, page.reviews);
  const inbox = rememberReviews(deps.cacheDir, appId, page.reviews, page.next);
  const reviews = unrepliedOnly ? inbox.reviews.filter((review) => review.response === null) : inbox.reviews;
  return ok({ appId, reviews, next: inbox.next, fetchedAt: inbox.fetchedAt });
}

async function reply(deps: CliDeps, reviewId: string, body: string, appFlag: string) {
  if (!reviewId) return fail("usage", "reviews reply requires --review");
  const found = findCachedReview(deps.cacheDir, reviewId);
  const appId = appFlag || found?.appId || loadConfig(deps.configDir).activeAppId;
  const ref = parseAppRef(appId);
  if (ref.store === "play") {
    const valid = validatePlayReplyBody(body);
    if (!valid.ok) return fail("usage", valid.message);
    const created = await playClientFor(deps).createReply(ref.id, reviewId, valid.body);
    patchCachedReply(deps.cacheDir, reviewId, {
      id: created.responseId,
      body: valid.body,
      lastModifiedDate: new Date().toISOString(),
      state: "PUBLISHED",
    });
    return ok(created);
  }
  const valid = validateReplyBody(body);
  if (!valid.ok) return fail("usage", valid.message);
  const created = await appleClientFor(deps).createReply(reviewId, valid.body);
  patchCachedReply(deps.cacheDir, reviewId, {
    id: created.responseId,
    body: valid.body,
    lastModifiedDate: new Date().toISOString(),
    state: "PUBLISHED",
  });
  return ok(created);
}

async function deleteReply(deps: CliDeps, responseId: string, appFlag: string) {
  if (!responseId) return fail("usage", "reviews delete-reply requires --response");
  const appId = appFlag || loadConfig(deps.configDir).activeAppId;
  if (parseAppRef(appId).store === "play") {
    return fail("usage", "Google Play cannot delete a reply. Update it instead.");
  }
  const deleted = await appleClientFor(deps).deleteReply(responseId);
  clearCachedReply(deps.cacheDir, responseId);
  return ok(deleted);
}

async function poll(deps: CliDeps) {
  const config = loadConfig(deps.configDir);
  if (!isConfigured(config)) return ok({ configured: false, unrepliedCount: 0, newReviews: [] });
  return ok(await runPoll({
    configDir: deps.configDir,
    cacheDir: deps.cacheDir,
    fetchApps: async () => {
      const listed = await listApps(deps);
      if (!listed.ok) throw listed;
      return (listed.data as { apps: AppInfo[] }).apps;
    },
    fetchReviews: async (appId) => fetchReviewPage(deps, appId, ""),
  }));
}

async function fetchReviewPage(deps: CliDeps, appId: string, nextCursor: string) {
  const ref = parseAppRef(appId);
  if (ref.store === "play") {
    const page = await playClientFor(deps).listReviews(ref.id, nextCursor || undefined);
    return { appId: ref.ref, reviews: page.reviews, next: page.next };
  }
  const page = await appleClientFor(deps).listReviews(ref.id, nextCursor || undefined);
  return { appId: ref.ref, reviews: page.reviews, next: page.next };
}

function appleClientFor(deps: CliDeps): AppleClient {
  const config = loadConfig(deps.configDir);
  if (!isAppleConfigured(config)) {
    throw fail("config", "App Store Connect is not configured");
  }
  const pem = readFileSync(config.privateKeyPath, "utf8");
  if (deps.createClient) return deps.createClient(config, pem);
  return createAppleClient({ issuerId: config.issuerId, keyId: config.keyId, pem });
}

function playClientFor(deps: CliDeps): PlayClient {
  const config = loadConfig(deps.configDir);
  if (!isPlayConfigured(config)) {
    throw fail("config", "Google Play is not configured");
  }
  const json = readFileSync(config.playServiceAccountPath, "utf8");
  if (deps.createPlayClient) return deps.createPlayClient(config, json);
  return createPlayClient({ account: parsePlayServiceAccount(json) });
}

function playStubsFromWatched(ids: string[]): AppInfo[] {
  return ids.map((id) => parseAppRef(id)).filter((ref) => ref.store === "play" && ref.id !== "").map((ref) => ({
    id: ref.ref,
    name: ref.id,
    bundleId: ref.id,
    sku: "",
    store: "play" as const,
  }));
}

function mergePlayApps(listed: AppInfo[], watched: string[]): AppInfo[] {
  const ids = new Set(listed.map((app) => app.id));
  return [...listed, ...playStubsFromWatched(watched).filter((app) => !ids.has(app.id))];
}

function commandError(error: unknown): Envelope<unknown> {
  if (error && typeof error === "object" && "ok" in error) return error as Envelope<unknown>;
  if (error && typeof error === "object" && "code" in error && String((error as { code?: string }).code) === "play") {
    return playError(error);
  }
  return appleError(error);
}

function printEnvelope(envelope: Envelope<unknown>, compact: boolean): void {
  try {
    process.stdout.write(serializeCliJson(envelope, compact));
  } catch {
    process.stdout.write(serializeCliJson(fail("usage", "Backend output exceeded the size limit"), true));
  }
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

import { createPrivateKey, sign } from "node:crypto";
import type { AppInfo, ErrorCode, Review, ReviewList, ReviewResponse } from "./model";
import {
  HTTP_TIMEOUT_MS,
  JWT_LIFETIME_SEC,
  PLAY_PUBLISHER_SCOPE,
  PLAY_REPLY_MAX_CHARS,
  PLAY_REPORTING_SCOPE,
  PLAY_TOKEN_URI,
  REPLY_MIN_CHARS,
  fail,
  playAppId,
} from "./model";

const PLAY_BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const PLAY_REPORTING = "https://playdeveloperreporting.googleapis.com/v1beta1";

export interface PlayServiceAccount {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

export interface PlayClient {
  listApps(): Promise<AppInfo[]>;
  listReviews(packageName: string, nextToken?: string): Promise<Omit<ReviewList, "appId">>;
  createReply(packageName: string, reviewId: string, body: string): Promise<{ reviewId: string; responseId: string }>;
}

export function parsePlayServiceAccount(raw: string): PlayServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("Play service account JSON is invalid"), { code: "config" satisfies ErrorCode });
  }
  const record = asRecord(parsed);
  const clientEmail = stringValue(record.client_email);
  const privateKey = stringValue(record.private_key).replace(/\\n/g, "\n");
  if (clientEmail === "" || privateKey === "") {
    throw Object.assign(new Error("Play service account JSON must include client_email and private_key"), {
      code: "config" satisfies ErrorCode,
    });
  }
  return {
    clientEmail,
    privateKey,
    tokenUri: stringValue(record.token_uri) || PLAY_TOKEN_URI,
  };
}

export function mintPlayJwt(account: PlayServiceAccount, nowMs = Date.now()): string {
  const nowSec = Math.floor(nowMs / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: account.clientEmail,
    scope: `${PLAY_PUBLISHER_SCOPE} ${PLAY_REPORTING_SCOPE}`,
    aud: account.tokenUri,
    iat: nowSec,
    exp: nowSec + JWT_LIFETIME_SEC,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const key = createPrivateKey({ key: account.privateKey, format: "pem" });
  const signature = sign("sha256", Buffer.from(unsigned), key);
  return `${unsigned}.${signature.toString("base64url")}`;
}

export function validatePlayReplyBody(body: string): { ok: true; body: string } | { ok: false; message: string } {
  const trimmed = body.trim();
  if (trimmed.length < REPLY_MIN_CHARS) return { ok: false, message: "Reply text is required." };
  if (trimmed.length > PLAY_REPLY_MAX_CHARS) {
    return { ok: false, message: `Play replies must be ${PLAY_REPLY_MAX_CHARS} characters or fewer.` };
  }
  return { ok: true, body: trimmed };
}

export function mapPlayApps(payload: unknown): AppInfo[] {
  const root = asRecord(payload);
  const apps = Array.isArray(root.apps) ? root.apps : [];
  return apps.map((item) => {
    const record = asRecord(item);
    const packageName = stringValue(record.packageName);
    return {
      id: playAppId(packageName),
      name: stringValue(record.displayName) || packageName,
      bundleId: packageName,
      sku: "",
      store: "play" as const,
    };
  }).filter((app) => app.bundleId !== "");
}

export function mapPlayReviews(payload: unknown): Omit<ReviewList, "appId"> {
  const root = asRecord(payload);
  const items = Array.isArray(root.reviews) ? root.reviews : [];
  const reviews: Review[] = items.map((item) => {
    const record = asRecord(item);
    const reviewId = stringValue(record.reviewId);
    const comments = Array.isArray(record.comments) ? record.comments.map(asRecord) : [];
    const user = asRecord(comments.find((comment) => comment.userComment)?.userComment);
    const developer = asRecord(comments.find((comment) => comment.developerComment)?.developerComment);
    const rawText = stringValue(user.text);
    const split = rawText.split("\t");
    const title = split.length > 1 ? String(split[0] || "") : "";
    const body = split.length > 1 ? split.slice(1).join("\t") : rawText;
    const version = stringValue(user.appVersionName) || (numberValue(user.appVersionCode) ? String(numberValue(user.appVersionCode)) : "");
    const createdDate = timestampToIso(user.lastModified);
    const response: ReviewResponse | null = stringValue(developer.text)
      ? {
          id: `play:${reviewId}`,
          body: stringValue(developer.text),
          lastModifiedDate: timestampToIso(developer.lastModified),
          state: "PUBLISHED",
        }
      : null;
    return {
      id: reviewId,
      store: "play" as const,
      rating: numberValue(user.starRating),
      title,
      body,
      nickname: stringValue(record.authorName),
      createdDate,
      territory: stringValue(user.reviewerLanguage),
      version,
      response,
    };
  }).filter((review) => review.id !== "");

  const pagination = asRecord(root.tokenPagination);
  return { reviews, next: stringValue(pagination.nextPageToken) };
}

export function createPlayClient(options: {
  account: PlayServiceAccount;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): PlayClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let accessToken = "";
  let expiresAtMs = 0;

  async function token(): Promise<string> {
    if (accessToken && now() + 60_000 < expiresAtMs) return accessToken;
    const assertion = mintPlayJwt(options.account, now());
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    });
    const response = await requestJson(options.account.tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const record = asRecord(response);
    accessToken = stringValue(record.access_token);
    const expiresIn = numberValue(record.expires_in) || 3600;
    expiresAtMs = now() + expiresIn * 1000;
    if (accessToken === "") {
      throw Object.assign(new Error("Play token response did not include access_token"), { code: "auth" satisfies ErrorCode });
    }
    return accessToken;
  }

  async function requestJson(url: string, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      throw Object.assign(new Error(error instanceof Error ? error.message : "Network request failed"), {
        code: "network" satisfies ErrorCode,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw Object.assign(new Error(await playErrorMessage(response)), {
        code: classifyPlayStatus(response.status),
        status: response.status,
      });
    }
    const text = await response.text();
    if (text.trim() === "") return {};
    return JSON.parse(text) as unknown;
  }

  async function authorized(url: string, init: RequestInit = {}): Promise<unknown> {
    return requestJson(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${await token()}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
  }

  return {
    async listApps() {
      return mapPlayApps(await authorized(`${PLAY_REPORTING}/apps:search?pageSize=200`));
    },
    async listReviews(packageName, nextToken) {
      const query = new URLSearchParams({ maxResults: "100" });
      if (nextToken) query.set("token", nextToken);
      return mapPlayReviews(await authorized(
        `${PLAY_BASE}/applications/${encodeURIComponent(packageName)}/reviews?${query.toString()}`,
      ));
    },
    async createReply(packageName, reviewId, body) {
      const valid = validatePlayReplyBody(body);
      if (!valid.ok) {
        throw Object.assign(new Error(valid.message), { code: "usage" satisfies ErrorCode });
      }
      await authorized(
        `${PLAY_BASE}/applications/${encodeURIComponent(packageName)}/reviews/${encodeURIComponent(reviewId)}:reply`,
        { method: "POST", body: JSON.stringify({ replyText: valid.body }) },
      );
      return { reviewId, responseId: `play:${reviewId}` };
    },
  };
}

export function playError(error: unknown) {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: string }).code) as ErrorCode;
    const message = error instanceof Error ? error.message : "Google Play request failed";
    if (code === "auth" || code === "forbidden" || code === "network" || code === "play" || code === "usage" || code === "config") {
      return fail(code, message);
    }
  }
  return fail("play", error instanceof Error ? error.message : "Google Play request failed");
}

function classifyPlayStatus(status: number): ErrorCode {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  return "play";
}

function timestampToIso(value: unknown): string {
  const record = asRecord(value);
  const seconds = numberValue(record.seconds);
  if (!seconds) return "";
  return new Date(seconds * 1000).toISOString();
}

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function playErrorMessage(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message || `Google Play returned ${response.status}`;
  } catch {
    return `Google Play returned ${response.status}`;
  }
}

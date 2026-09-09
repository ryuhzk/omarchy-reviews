import { createPrivateKey, sign } from "node:crypto";
import type { AppInfo, ErrorCode, Review, ReviewList, ReviewResponse } from "./model";
import { HTTP_MAX_BODY_BYTES, HTTP_MAX_ERROR_BYTES, readLimitedJson } from "./http-limit";
import { ASC_AUDIENCE, HTTP_TIMEOUT_MS, JWT_LIFETIME_SEC, REPLY_MAX_CHARS, REPLY_MIN_CHARS, REVIEW_PAGE_LIMIT, fail } from "./model";

const ASC_BASE = "https://api.appstoreconnect.apple.com";

export interface JwtInput {
  issuerId: string;
  keyId: string;
  pem: string;
  nowMs?: number;
}

export interface TokenCache {
  token: string;
  expiresAtMs: number;
}

export function mintJwt(input: JwtInput): string {
  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const header = { alg: "ES256", kid: input.keyId, typ: "JWT" };
  const payload = {
    iss: input.issuerId,
    iat: nowSec,
    exp: nowSec + JWT_LIFETIME_SEC,
    aud: ASC_AUDIENCE,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const key = createPrivateKey({ key: input.pem, format: "pem" });
  const signature = sign("sha256", Buffer.from(unsigned), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${unsigned}.${signature.toString("base64url")}`;
}

export function cachedToken(cache: TokenCache | null, nowMs: number): string | null {
  if (!cache) return null;
  if (nowMs + 60_000 >= cache.expiresAtMs) return null;
  return cache.token;
}

export function classifyHttpStatus(status: number): ErrorCode {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  return "apple";
}

export function isAllowedAppleNextUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.hostname !== "api.appstoreconnect.apple.com") return false;
  if (parsed.port !== "" && parsed.port !== "443") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.hash !== "") return false;
  const path = parsed.pathname;
  if (path.includes("..") || path.includes("//") || path.includes("\\")) return false;
  return /^\/v1\/apps\/[^/]+\/customerReviews\/?$/.test(path);
}

export function validateReplyBody(body: string): { ok: true; body: string } | { ok: false; message: string } {
  const trimmed = body.trim();
  if (trimmed.length < REPLY_MIN_CHARS) {
    return { ok: false, message: "Reply text is required." };
  }
  if (trimmed.length > REPLY_MAX_CHARS) {
    return { ok: false, message: `Reply text must be ${REPLY_MAX_CHARS} characters or fewer.` };
  }
  return { ok: true, body: trimmed };
}

export function replyRequest(reviewId: string, body: string) {
  return {
    data: {
      type: "customerReviewResponses",
      attributes: { responseBody: body },
      relationships: {
        review: { data: { type: "customerReviews", id: reviewId } },
      },
    },
  };
}

export function mapApps(payload: unknown): AppInfo[] {
  const root = asRecord(payload);
  const data = Array.isArray(root.data) ? root.data : [];
  return data.map((item) => {
    const record = asRecord(item);
    const attributes = asRecord(record.attributes);
    return {
      id: stringValue(record.id),
      name: stringValue(attributes.name),
      bundleId: stringValue(attributes.bundleId),
      sku: stringValue(attributes.sku),
      store: "apple" as const,
    };
  }).filter((app) => app.id !== "");
}

export function mapReviews(payload: unknown): Omit<ReviewList, "appId"> {
  const root = asRecord(payload);
  const included = new Map<string, ReviewResponse>();
  if (Array.isArray(root.included)) {
    for (const item of root.included) {
      const record = asRecord(item);
      if (stringValue(record.type) !== "customerReviewResponses") continue;
      const attributes = asRecord(record.attributes);
      included.set(stringValue(record.id), {
        id: stringValue(record.id),
        body: stringValue(attributes.responseBody),
        lastModifiedDate: stringValue(attributes.lastModifiedDate),
        state: stringValue(attributes.state),
      });
    }
  }

  const data = Array.isArray(root.data) ? root.data : [];
  const reviews: Review[] = data.map((item) => {
    const record = asRecord(item);
    const attributes = asRecord(record.attributes);
    const relationships = asRecord(record.relationships);
    const responseRel = asRecord(asRecord(relationships.response).data);
    const responseId = stringValue(responseRel.id);
    return {
      id: stringValue(record.id),
      store: "apple" as const,
      rating: numberValue(attributes.rating),
      title: stringValue(attributes.title),
      body: stringValue(attributes.body),
      nickname: stringValue(attributes.reviewerNickname),
      createdDate: stringValue(attributes.createdDate),
      territory: stringValue(attributes.territory),
      version: "",
      response: responseId ? included.get(responseId) ?? { id: responseId, body: "", lastModifiedDate: "", state: "" } : null,
    };
  }).filter((review) => review.id !== "");

  const links = asRecord(root.links);
  return { reviews, next: stringValue(links.next) };
}

export interface AppleClient {
  listApps(): Promise<AppInfo[]>;
  listReviews(appId: string, nextUrl?: string): Promise<Omit<ReviewList, "appId">>;
  createReply(reviewId: string, body: string): Promise<{ reviewId: string; responseId: string }>;
  deleteReply(responseId: string): Promise<{ responseId: string }>;
}

export function createAppleClient(options: {
  issuerId: string;
  keyId: string;
  pem: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): AppleClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let cache: TokenCache | null = null;

  async function token(): Promise<string> {
    const current = cachedToken(cache, now());
    if (current) return current;
    const minted = mintJwt({
      issuerId: options.issuerId,
      keyId: options.keyId,
      pem: options.pem,
      nowMs: now(),
    });
    cache = { token: minted, expiresAtMs: now() + JWT_LIFETIME_SEC * 1000 };
    return minted;
  }

  async function request(url: string, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${await token()}`,
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
    } catch (error) {
      throw Object.assign(new Error(error instanceof Error ? error.message : "Network request failed"), {
        code: "network" satisfies ErrorCode,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const message = await errorMessage(response);
      throw Object.assign(new Error(message), { code: classifyHttpStatus(response.status), status: response.status });
    }
    if (response.status === 204) return {};
    return readLimitedJson(response, HTTP_MAX_BODY_BYTES);
  }

  return {
    async listApps() {
      const payload = await request(`${ASC_BASE}/v1/apps?limit=200`);
      return mapApps(payload);
    },
    async listReviews(appId, nextUrl) {
      if (nextUrl) {
        if (!isAllowedAppleNextUrl(nextUrl)) {
          throw Object.assign(new Error("Rejected pagination URL"), { code: "apple" satisfies ErrorCode });
        }
      }
      const url = nextUrl
        ? nextUrl
        : `${ASC_BASE}/v1/apps/${encodeURIComponent(appId)}/customerReviews?include=response&sort=-createdDate&limit=${REVIEW_PAGE_LIMIT}`;
      return mapReviews(await request(url));
    },
    async createReply(reviewId, body) {
      const valid = validateReplyBody(body);
      if (!valid.ok) {
        throw Object.assign(new Error(valid.message), { code: "usage" satisfies ErrorCode });
      }
      const payload = await request(`${ASC_BASE}/v1/customerReviewResponses`, {
        method: "POST",
        body: JSON.stringify(replyRequest(reviewId, valid.body)),
      });
      const data = asRecord(asRecord(payload).data);
      return { reviewId, responseId: stringValue(data.id) };
    },
    async deleteReply(responseId) {
      await request(`${ASC_BASE}/v1/customerReviewResponses/${encodeURIComponent(responseId)}`, {
        method: "DELETE",
      });
      return { responseId };
    },
  };
}

export function appleError(error: unknown) {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: string }).code) as ErrorCode;
    const message = error instanceof Error ? error.message : "App Store Connect request failed";
    if (code === "auth" || code === "forbidden" || code === "network" || code === "apple" || code === "usage" || code === "config") {
      return fail(code, message);
    }
  }
  return fail("apple", error instanceof Error ? error.message : "App Store Connect request failed");
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

async function errorMessage(response: Response): Promise<string> {
  try {
    const payload = await readLimitedJson(response, HTTP_MAX_ERROR_BYTES) as { errors?: Array<{ detail?: string; title?: string }> };
    const first = payload.errors?.[0];
    return first?.detail || first?.title || `App Store Connect returned ${response.status}`;
  } catch (error) {
    if (error instanceof Error && error.message.includes("exceeded")) throw error;
    return `App Store Connect returned ${response.status}`;
  }
}

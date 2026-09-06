export type ErrorCode = "auth" | "forbidden" | "network" | "config" | "apple" | "play" | "usage";
export type Store = "apple" | "play";

export interface AppRef {
  store: Store;
  id: string;
  ref: string;
}

export function parseAppRef(raw: string): AppRef {
  const value = String(raw || "").trim();
  if (value.startsWith("play:")) {
    const id = value.slice(5);
    return { store: "play", id, ref: `play:${id}` };
  }
  if (value.startsWith("apple:")) {
    const id = value.slice(6);
    return { store: "apple", id, ref: id };
  }
  return { store: "apple", id: value, ref: value };
}

export function playAppId(packageName: string): string {
  return `play:${packageName}`;
}

export interface OkEnvelope<T> {
  ok: true;
  data: T;
}

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
  };
}

export type Envelope<T> = OkEnvelope<T> | ErrorEnvelope;

export interface PluginConfig {
  issuerId: string;
  keyId: string;
  privateKeyPath: string;
  playServiceAccountPath: string;
  watchedAppIds: string[];
  activeAppId: string;
}

export interface ConfigShow {
  configured: boolean;
  appleConfigured: boolean;
  playConfigured: boolean;
  issuerId: string;
  keyId: string;
  keyPath: string;
  keyPathExists: boolean;
  playKeyPath: string;
  playKeyPathExists: boolean;
  watchedAppIds: string[];
  activeAppId: string;
}

export interface AppInfo {
  id: string;
  name: string;
  bundleId: string;
  sku: string;
  store: Store;
}

export interface ReviewResponse {
  id: string;
  body: string;
  lastModifiedDate: string;
  state: string;
}

export interface Review {
  id: string;
  store: Store;
  rating: number;
  title: string;
  body: string;
  nickname: string;
  createdDate: string;
  territory: string;
  version: string;
  response: ReviewResponse | null;
}

export interface ReviewList {
  appId: string;
  reviews: Review[];
  next: string;
}

export interface CachedInbox {
  appId: string;
  reviews: Review[];
  next: string;
  fetchedAt: string;
}

export interface NewReview {
  appId: string;
  appName: string;
  reviewId: string;
  rating: number;
  title: string;
  body: string;
}

export interface PollResult {
  configured: boolean;
  unrepliedCount: number;
  newReviews: NewReview[];
}

export const ASC_AUDIENCE = "appstoreconnect-v1";
export const JWT_LIFETIME_SEC = 15 * 60;
export const JWT_REUSE_SKEW_SEC = 60;
export const HTTP_TIMEOUT_MS = 20_000;
export const REPLY_MIN_CHARS = 1;
export const REPLY_MAX_CHARS = 4000;
export const PLAY_REPLY_MAX_CHARS = 350;
export const PLAY_TOKEN_URI = "https://oauth2.googleapis.com/token";
export const PLAY_PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher";
export const PLAY_REPORTING_SCOPE = "https://www.googleapis.com/auth/playdeveloperreporting";
export const REVIEW_PAGE_LIMIT = 50;

export function ok<T>(data: T): OkEnvelope<T> {
  return { ok: true, data };
}

export function fail(code: ErrorCode, message: string): ErrorEnvelope {
  return { ok: false, error: { code, message } };
}

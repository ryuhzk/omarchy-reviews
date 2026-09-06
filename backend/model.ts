export type ErrorCode = "auth" | "forbidden" | "network" | "config" | "apple" | "usage";

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
  watchedAppIds: string[];
  activeAppId: string;
}

export interface ConfigShow {
  configured: boolean;
  issuerId: string;
  keyId: string;
  keyPath: string;
  keyPathExists: boolean;
  watchedAppIds: string[];
  activeAppId: string;
}

export interface AppInfo {
  id: string;
  name: string;
  bundleId: string;
  sku: string;
}

export interface ReviewResponse {
  id: string;
  body: string;
  lastModifiedDate: string;
  state: string;
}

export interface Review {
  id: string;
  rating: number;
  title: string;
  body: string;
  nickname: string;
  createdDate: string;
  territory: string;
  response: ReviewResponse | null;
}

export interface ReviewList {
  appId: string;
  reviews: Review[];
  next: string;
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
export const REVIEW_PAGE_LIMIT = 50;

export function ok<T>(data: T): OkEnvelope<T> {
  return { ok: true, data };
}

export function fail(code: ErrorCode, message: string): ErrorEnvelope {
  return { ok: false, error: { code, message } };
}

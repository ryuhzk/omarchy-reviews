import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createAppleClient, isAllowedAppleNextUrl } from "../backend/apple";
import { createPlayClient } from "../backend/play";
import {
  CLI_MAX_OUTPUT_BYTES,
  HTTP_MAX_BODY_BYTES,
  readLimitedJson,
  serializeCliJson,
} from "../backend/http-limit";
import { PLAY_TOKEN_URI, fail, ok } from "../backend/model";

function pemPair() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function rsaPem() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function chunkedBody(bytes: number, chunkSize = 64 * 1024): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= bytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkSize, bytes - sent);
      controller.enqueue(new Uint8Array(size));
      sent += size;
    },
  });
}

describe("isAllowedAppleNextUrl", () => {
  test("accepts an exact App Store Connect customerReviews URL", () => {
    expect(isAllowedAppleNextUrl(
      "https://api.appstoreconnect.apple.com/v1/apps/app-1/customerReviews?cursor=2",
    )).toBe(true);
  });

  test("rejects prefix hosts that would steal the Bearer token", () => {
    expect(isAllowedAppleNextUrl(
      "https://api.appstoreconnect.apple.com.attacker.tld/v1/apps/app-1/customerReviews",
    )).toBe(false);
    expect(isAllowedAppleNextUrl(
      "https://api.appstoreconnect.apple.com.evil.com/v1/apps/app-1/customerReviews",
    )).toBe(false);
  });

  test("rejects credentials, http, and non-443 ports", () => {
    expect(isAllowedAppleNextUrl(
      "https://user:pass@api.appstoreconnect.apple.com/v1/apps/app-1/customerReviews",
    )).toBe(false);
    expect(isAllowedAppleNextUrl(
      "http://api.appstoreconnect.apple.com/v1/apps/app-1/customerReviews",
    )).toBe(false);
    expect(isAllowedAppleNextUrl(
      "https://api.appstoreconnect.apple.com:8443/v1/apps/app-1/customerReviews",
    )).toBe(false);
  });

  test("rejects paths outside customerReviews pagination", () => {
    expect(isAllowedAppleNextUrl("https://api.appstoreconnect.apple.com/v1/apps")).toBe(false);
    expect(isAllowedAppleNextUrl("https://api.appstoreconnect.apple.com/v1/apps/app-1/customerReviews/extra")).toBe(false);
    expect(isAllowedAppleNextUrl("https://api.appstoreconnect.apple.com/v1/customerReviewResponses")).toBe(false);
  });
});

describe("readLimitedJson", () => {
  test("rejects a declared Content-Length above the cap without trusting the body", async () => {
    const response = new Response("{}", {
      status: 200,
      headers: { "Content-Length": String(HTTP_MAX_BODY_BYTES + 1) },
    });
    await expect(readLimitedJson(response)).rejects.toThrow(/exceeded/);
  });

  test("stops a chunked body once the streamed byte cap is crossed", async () => {
    const response = new Response(chunkedBody(HTTP_MAX_BODY_BYTES + 64 * 1024), { status: 200 });
    await expect(readLimitedJson(response)).rejects.toThrow(/exceeded/);
  });
});

describe("serializeCliJson", () => {
  test("refuses to emit an oversized CLI envelope", () => {
    const huge = { ok: true, data: { pad: "x".repeat(CLI_MAX_OUTPUT_BYTES) } };
    expect(() => serializeCliJson(huge, true)).toThrow(/exceeded/);
    expect(serializeCliJson(ok({ n: 1 }), true)).toBe(`${JSON.stringify(ok({ n: 1 }))}\n`);
    expect(serializeCliJson(fail("usage", "no"), true)).toContain("\"ok\":false");
  });
});

describe("createAppleClient limits", () => {
  test("does not follow a hostile pagination origin", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const client = createAppleClient({ issuerId: "ISS", keyId: "KID", pem: pemPair(), fetchImpl });
    await expect(client.listReviews(
      "app-1",
      "https://api.appstoreconnect.apple.com.attacker.tld/v1/apps/app-1/customerReviews?cursor=2",
    )).rejects.toThrow(/pagination/i);
    expect(calls).toEqual([]);
  });

  test("rejects an oversized Apple review page", async () => {
    const fetchImpl = (async () => new Response(chunkedBody(HTTP_MAX_BODY_BYTES + 1024), { status: 200 })) as typeof fetch;
    const client = createAppleClient({ issuerId: "ISS", keyId: "KID", pem: pemPair(), fetchImpl });
    await expect(client.listReviews("app-1")).rejects.toThrow(/exceeded/);
  });
});

describe("createPlayClient limits", () => {
  test("rejects an oversized Play review page after the token exchange", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "ya29.x", expires_in: 3600 }), { status: 200 });
      }
      return new Response(chunkedBody(HTTP_MAX_BODY_BYTES + 1024), { status: 200 });
    }) as typeof fetch;
    const client = createPlayClient({
      account: { clientEmail: "reviews@proj.iam.gserviceaccount.com", privateKey: rsaPem(), tokenUri: PLAY_TOKEN_URI },
      fetchImpl,
    });
    await expect(client.listReviews("com.example.app")).rejects.toThrow(/exceeded/);
  });
});

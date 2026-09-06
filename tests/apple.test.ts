import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  classifyHttpStatus,
  createAppleClient,
  mintJwt,
  mapApps,
  mapReviews,
  replyRequest,
  validateReplyBody,
} from "../backend/apple";
import { ASC_AUDIENCE, JWT_LIFETIME_SEC } from "../backend/model";

function pemPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

describe("mintJwt", () => {
  test("emits ES256 claims without embedding the PEM", () => {
    const { pem } = pemPair();
    const nowMs = 1_700_000_000_000;
    const token = mintJwt({
      issuerId: "ISSUER",
      keyId: "KEYID",
      pem,
      nowMs,
    });

    const [headerPart, payloadPart, signaturePart] = token.split(".");
    const header = JSON.parse(Buffer.from(headerPart ?? "", "base64url").toString());
    const payload = JSON.parse(Buffer.from(payloadPart ?? "", "base64url").toString());

    expect(header).toEqual({ alg: "ES256", kid: "KEYID", typ: "JWT" });
    expect(payload.iss).toBe("ISSUER");
    expect(payload.aud).toBe(ASC_AUDIENCE);
    expect(payload.iat).toBe(1_700_000_000);
    expect(payload.exp).toBe(1_700_000_000 + JWT_LIFETIME_SEC);
    expect(signaturePart?.length ?? 0).toBeGreaterThan(20);
    expect(token).not.toContain("BEGIN PRIVATE KEY");
  });
});

describe("mapApps", () => {
  test("reads id, name, bundleId, and sku", () => {
    const apps = mapApps({
      data: [
        {
          id: "app-1",
          attributes: { name: "Brifdo", bundleId: "com.brifdo.app", sku: "BRIFDO" },
        },
      ],
    });
    expect(apps).toEqual([
      { id: "app-1", name: "Brifdo", bundleId: "com.brifdo.app", sku: "BRIFDO" },
    ]);
  });
});

describe("mapReviews", () => {
  test("joins included responses and treats missing response as unreplied", () => {
    const mapped = mapReviews({
      data: [
        {
          id: "rev-1",
          attributes: {
            rating: 2,
            title: "Crash",
            body: "It crashes",
            reviewerNickname: "Pat",
            createdDate: "2026-09-01T10:00:00Z",
            territory: "USA",
          },
          relationships: { response: { data: { id: "resp-1", type: "customerReviewResponses" } } },
        },
        {
          id: "rev-2",
          attributes: {
            rating: 5,
            title: "Love it",
            body: "Great",
            reviewerNickname: "Sam",
            createdDate: "2026-09-02T10:00:00Z",
            territory: "GBR",
          },
        },
      ],
      included: [
        {
          type: "customerReviewResponses",
          id: "resp-1",
          attributes: {
            responseBody: "Sorry about that",
            lastModifiedDate: "2026-09-01T12:00:00Z",
            state: "PUBLISHED",
          },
        },
      ],
      links: { next: "https://api.appstoreconnect.apple.com/v1/apps/app-1/customerReviews?cursor=2" },
    });

    expect(mapped.reviews[0]?.response?.id).toBe("resp-1");
    expect(mapped.reviews[0]?.response?.body).toBe("Sorry about that");
    expect(mapped.reviews[1]?.response).toBeNull();
    expect(mapped.next).toContain("cursor=2");
  });
});

describe("replyRequest", () => {
  test("builds the official create-response body", () => {
    expect(replyRequest("rev-9", "Thanks for writing")).toEqual({
      data: {
        type: "customerReviewResponses",
        attributes: { responseBody: "Thanks for writing" },
        relationships: {
          review: { data: { type: "customerReviews", id: "rev-9" } },
        },
      },
    });
  });
});

describe("validateReplyBody", () => {
  test("rejects empty and oversized replies", () => {
    expect(validateReplyBody("").ok).toBe(false);
    expect(validateReplyBody("   ").ok).toBe(false);
    expect(validateReplyBody("Thanks").ok).toBe(true);
    expect(validateReplyBody("x".repeat(4000)).ok).toBe(true);
    expect(validateReplyBody("x".repeat(4001)).ok).toBe(false);
  });
});

describe("classifyHttpStatus", () => {
  test("maps Apple status codes to envelope codes", () => {
    expect(classifyHttpStatus(401)).toBe("auth");
    expect(classifyHttpStatus(403)).toBe("forbidden");
    expect(classifyHttpStatus(409)).toBe("apple");
    expect(classifyHttpStatus(500)).toBe("apple");
  });
});

describe("createAppleClient", () => {
  test("lists reviews through the injected fetch and posts a reply", async () => {
    const { pem } = pemPair();
    const calls: Array<{ url: string; method: string; body: string }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method || "GET");
      const body = String(init?.body || "");
      calls.push({ url, method, body });
      if (url.includes("/customerReviews") && method === "GET") {
        return new Response(JSON.stringify({
          data: [{
            id: "rev-1",
            attributes: { rating: 4, title: "Nice", body: "Works", reviewerNickname: "Ada", createdDate: "2026-09-01T00:00:00Z", territory: "USA" },
          }],
        }), { status: 200 });
      }
      if (url.endsWith("/customerReviewResponses") && method === "POST") {
        return new Response(JSON.stringify({ data: { id: "resp-22" } }), { status: 201 });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const client = createAppleClient({ issuerId: "ISS", keyId: "KID", pem, fetchImpl });
    const listed = await client.listReviews("app-1");
    const replied = await client.createReply("rev-1", "Thanks");

    expect(listed.reviews[0]?.id).toBe("rev-1");
    expect(replied.responseId).toBe("resp-22");
    expect(calls[0]?.url).toContain("/v1/apps/app-1/customerReviews");
    expect(calls[1]?.body).toContain("Thanks");
    expect(JSON.stringify(calls)).not.toContain("BEGIN PRIVATE KEY");
  });
});

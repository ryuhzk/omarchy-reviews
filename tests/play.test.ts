import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  createPlayClient,
  mapPlayApps,
  mapPlayReviews,
  mintPlayJwt,
  parsePlayServiceAccount,
  validatePlayReplyBody,
} from "../backend/play";
import { PLAY_REPLY_MAX_CHARS, PLAY_TOKEN_URI } from "../backend/model";

function rsaPem() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

describe("parsePlayServiceAccount", () => {
  test("reads client_email and private_key", () => {
    const account = parsePlayServiceAccount(JSON.stringify({
      client_email: "reviews@proj.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n",
    }));
    expect(account.clientEmail).toBe("reviews@proj.iam.gserviceaccount.com");
    expect(account.privateKey).toContain("BEGIN PRIVATE KEY");
    expect(account.tokenUri).toBe(PLAY_TOKEN_URI);
  });
});

describe("mintPlayJwt", () => {
  test("emits RS256 claims without embedding the PEM", () => {
    const pem = rsaPem();
    const token = mintPlayJwt({
      clientEmail: "reviews@proj.iam.gserviceaccount.com",
      privateKey: pem,
      tokenUri: PLAY_TOKEN_URI,
    }, 1_700_000_000_000);
    const [headerPart, payloadPart] = token.split(".");
    const header = JSON.parse(Buffer.from(headerPart ?? "", "base64url").toString());
    const payload = JSON.parse(Buffer.from(payloadPart ?? "", "base64url").toString());
    expect(header.alg).toBe("RS256");
    expect(payload.iss).toBe("reviews@proj.iam.gserviceaccount.com");
    expect(payload.aud).toBe(PLAY_TOKEN_URI);
    expect(token).not.toContain("BEGIN PRIVATE KEY");
  });
});

describe("mapPlayReviews", () => {
  test("maps title, version, store, and an existing developer reply", () => {
    const mapped = mapPlayReviews({
      reviews: [
        {
          reviewId: "gp-1",
          authorName: "Sam",
          comments: [
            {
              userComment: {
                text: "Laggy\tNeeds a fix",
                starRating: 2,
                lastModified: { seconds: "1757203200", nanos: 0 },
                reviewerLanguage: "en",
                appVersionName: "2.0.0",
                appVersionCode: 20,
              },
            },
            {
              developerComment: {
                text: "Fixing it",
                lastModified: { seconds: "1757289600", nanos: 0 },
              },
            },
          ],
        },
      ],
      tokenPagination: { nextPageToken: "page-2" },
    });

    expect(mapped.next).toBe("page-2");
    expect(mapped.reviews[0]).toMatchObject({
      id: "gp-1",
      store: "play",
      rating: 2,
      title: "Laggy",
      body: "Needs a fix",
      nickname: "Sam",
      territory: "en",
      version: "2.0.0",
    });
    expect(mapped.reviews[0]?.response?.body).toBe("Fixing it");
  });
});

describe("mapPlayApps", () => {
  test("prefixes package names as play app ids", () => {
    expect(mapPlayApps({
      apps: [{ packageName: "com.brifdo.app", displayName: "Brifdo" }],
    })).toEqual([
      { id: "play:com.brifdo.app", name: "Brifdo", bundleId: "com.brifdo.app", sku: "", store: "play" },
    ]);
  });
});

describe("validatePlayReplyBody", () => {
  test("rejects Play replies over 350 characters", () => {
    expect(validatePlayReplyBody("Thanks").ok).toBe(true);
    expect(validatePlayReplyBody("x".repeat(PLAY_REPLY_MAX_CHARS + 1)).ok).toBe(false);
  });
});

describe("createPlayClient", () => {
  test("lists reviews after exchanging a service-account JWT", async () => {
    const pem = rsaPem();
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method || "GET"} ${url}`);
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "ya29.play", expires_in: 3600 }), { status: 200 });
      }
      if (url.includes("/reviews") && !url.includes(":reply")) {
        return new Response(JSON.stringify({
          reviews: [{
            reviewId: "gp-9",
            authorName: "Ada",
            comments: [{ userComment: { text: "Nice", starRating: 5, appVersionName: "1.4" } }],
          }],
        }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const client = createPlayClient({
      account: { clientEmail: "reviews@proj.iam.gserviceaccount.com", privateKey: pem, tokenUri: PLAY_TOKEN_URI },
      fetchImpl,
    });
    const listed = await client.listReviews("com.brifdo.app");
    expect(listed.reviews[0]?.store).toBe("play");
    expect(listed.reviews[0]?.version).toBe("1.4");
    expect(JSON.stringify(calls)).toContain("/applications/com.brifdo.app/reviews");
  });
});

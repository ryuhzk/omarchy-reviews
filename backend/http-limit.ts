export const HTTP_MAX_BODY_BYTES = 1_048_576;
export const HTTP_MAX_ERROR_BYTES = 16_384;
export const CLI_MAX_OUTPUT_BYTES = 1_048_576;

export async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw Object.assign(new Error(`Response exceeded ${maxBytes} bytes`), { code: "network" });
  }

  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw Object.assign(new Error(`Response exceeded ${maxBytes} bytes`), { code: "network" });
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already canceled or released after a size-limit abort.
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export async function readLimitedJson(response: Response, maxBytes = HTTP_MAX_BODY_BYTES): Promise<unknown> {
  const text = await readLimitedText(response, maxBytes);
  if (text.trim() === "") return {};
  return JSON.parse(text) as unknown;
}

export function serializeCliJson(value: unknown, compact: boolean): string {
  const text = `${JSON.stringify(value, null, compact ? 0 : 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > CLI_MAX_OUTPUT_BYTES) {
    throw Object.assign(new Error("Backend output exceeded the size limit"), { code: "usage" });
  }
  return text;
}

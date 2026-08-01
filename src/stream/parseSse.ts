/**
 * Incremental SSE parser for Node (no browser EventSource required).
 * Emits completed `data:` payloads (multi-line data joined with \n).
 */

export type SseMessage = {
  event: string | null;
  data: string;
  id: string | null;
  retry: number | null;
};

export class SseParser {
  private buffer = "";

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    // SSE events end with blank line
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) >= 0) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const msg = parseBlock(raw);
      if (msg) out.push(msg);
    }
    // also handle \r\n\r\n
    while ((idx = this.buffer.indexOf("\r\n\r\n")) >= 0) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 4);
      const msg = parseBlock(raw);
      if (msg) out.push(msg);
    }
    return out;
  }

  reset(): void {
    this.buffer = "";
  }
}

function parseBlock(raw: string): SseMessage | null {
  const lines = raw.split(/\r?\n/);
  let event: string | null = null;
  let id: string | null = null;
  let retry: number | null = null;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue; // comment / ping
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "retry") {
      const n = Number(value);
      if (Number.isFinite(n)) retry = n;
    }
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n"), id, retry };
}

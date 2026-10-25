import { object } from "../gateway/config";
import type { Body } from "../gateway/protocol";
import { getSseData, splitSseEvents } from "../utils/sseParser";

/** Pulls parsed JSON events out of an SSE body, one at a time, so a caller can stop reading whenever it likes. */
export class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private rest = "";
  private queue: string[] = [];
  private closed = false;

  constructor(body: ReadableStream<Uint8Array>) { this.reader = body.getReader(); }

  /** null once the stream has ended. Events that are not JSON objects (and `[DONE]`) are skipped. */
  async next(): Promise<Body | null> {
    for (;;) {
      while (this.queue.length) {
        const raw = getSseData(this.queue.shift() as string);
        if (!raw || raw === "[DONE]") continue;
        try {
          const value = JSON.parse(raw);
          if (object(value)) return value;
        } catch { /* a half-written event is not an event */ }
      }
      if (this.closed) return null;
      const { done, value } = await this.reader.read();
      if (done) {
        this.closed = true;
        this.rest += this.decoder.decode();
        if (this.rest.trim()) this.queue.push(this.rest);
        this.rest = "";
        continue;
      }
      const parsed = splitSseEvents(this.rest + this.decoder.decode(value, { stream: true }));
      this.rest = parsed.rest;
      this.queue.push(...parsed.events);
    }
  }
  cancel(reason?: unknown): Promise<void> { return this.reader.cancel(reason).catch(() => undefined); }
}

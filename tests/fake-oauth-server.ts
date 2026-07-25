import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { once } from "node:events";
import type { ProtocolEndpoints } from "../src/types.js";

export type FakeReply = {
  readonly status?: number;
  readonly body?: unknown;
  readonly rawBody?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly delayMs?: number;
  readonly bodyDelayMs?: number;
};

export type CapturedRequest = {
  readonly path: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly form: URLSearchParams;
};

function readRequestBody(request: IncomingMessage): Promise<string> {
  request.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: unknown) => {
      if (typeof chunk !== "string") {
        reject(new TypeError("Expected a UTF-8 request chunk"));
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      resolve(body);
    });
    request.on("error", (error) => {
      reject(error);
    });
  });
}

function sendReply(response: ServerResponse, reply: FakeReply): void {
  const raw = reply.rawBody ?? JSON.stringify(reply.body ?? {});
  response.writeHead(reply.status ?? 200, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(raw)),
    ...reply.headers,
  });
  if ((reply.bodyDelayMs ?? 0) > 0) {
    response.flushHeaders();
    setTimeout(() => {
      if (!response.destroyed) response.end(raw);
    }, reply.bodyDelayMs);
    return;
  }
  response.end(raw);
}

export class FakeOAuthServer {
  readonly requests: CapturedRequest[] = [];
  private readonly replies: FakeReply[] = [];
  private readonly server: Server;
  private origin = "";

  constructor() {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  enqueue(...replies: FakeReply[]): void {
    this.replies.push(...replies);
  }

  async start(): Promise<void> {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    if (address === null || typeof address === "string") throw new Error("Fake OAuth server has no TCP address");
    this.origin = `http://127.0.0.1:${String(address.port)}`;
  }

  endpoints(): ProtocolEndpoints {
    return {
      deviceAuthorization: `${this.origin}/oauth/device`,
      token: `${this.origin}/oauth/token`,
    };
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    this.server.close();
    await once(this.server, "close");
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readRequestBody(request);
    this.requests.push({ path: request.url ?? "", headers: request.headers, form: new URLSearchParams(body) });
    const reply = this.replies.shift() ?? { status: 500, body: { error: "missing_fake_reply" } };
    if ((reply.delayMs ?? 0) > 0) {
      setTimeout(() => {
        if (!response.destroyed) sendReply(response, reply);
      }, reply.delayMs);
      return;
    }
    sendReply(response, reply);
  }
}

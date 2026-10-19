import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

// Console monitoring (TASK-023): every console line gets a timestamp, a
// level, and — while a request is being handled — that request's short id,
// so handler log lines can be correlated with the request summary line.
const requestContext = new AsyncLocalStorage<{ requestId: string }>();

let consoleFormattingInstalled = false;

export function installConsoleFormatting(): void {
  if (consoleFormattingInstalled) return;
  consoleFormattingInstalled = true;
  const levels = [
    ["log", "INFO "],
    ["info", "INFO "],
    ["warn", "WARN "],
    ["error", "ERROR"],
  ] as const;
  for (const [method, label] of levels) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]): void => {
      const requestId = requestContext.getStore()?.requestId;
      const prefix = `${new Date().toISOString()} ${label}${requestId === undefined ? "" : ` [${requestId}]`}`;
      original(prefix, ...args);
    };
  }
}

// Message plus any error.code and the full error.cause chain on one line.
// Node's fetch reports only "fetch failed" and hides the real reason (DNS,
// TLS, connection refused) in `cause`, so the message alone is not enough.
export function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    if (current instanceof Error) {
      const code = (current as { code?: unknown }).code;
      parts.push(`${current.name}: ${current.message}${typeof code === "string" ? ` [${code}]` : ""}`);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" <- caused by: ");
}

// Stack trace of the outermost error, followed by its cause chain.
export function describeErrorWithStack(error: unknown): string {
  const stack = error instanceof Error && error.stack !== undefined ? error.stack : String(error);
  const hasCause = error instanceof Error && error.cause !== undefined;
  return hasCause ? `${stack}\n  cause chain: ${describeError(error)}` : stack;
}

function requestPath(request: IncomingMessage): string {
  // The query string is dropped: /auth/callback carries the OAuth `code`
  // and `state`, which must never reach the logs.
  return (request.url ?? "").split("?")[0] ?? "";
}

// Wraps the service's request listener with:
// - one summary line per request (method, path, status, duration), logged at
//   ERROR for 5xx, WARN for 4xx, INFO otherwise (successful /health
//   checks are not logged, to keep probes from flooding the console);
// - a last-resort catch that logs the stack and answers a generic 500
//   instead of leaving an unhandled rejection and a hung request.
export function withRequestMonitoring(listener: RequestListener): RequestListener {
  return (request: IncomingMessage, response: ServerResponse) => {
    const requestId = randomBytes(4).toString("hex");
    const startedAt = process.hrtime.bigint();
    const method = request.method ?? "?";
    const path = requestPath(request);

    response.on("close", () => {
      requestContext.run({ requestId }, () => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        const duration = `${durationMs.toFixed(1)}ms`;
        if (!response.writableFinished) {
          console.warn(`${method} ${path} aborted before the response completed (${duration})`);
          return;
        }
        const status = response.statusCode;
        const line = `${method} ${path} -> ${status} (${duration})`;
        if (status >= 500) console.error(line);
        else if (status >= 400) console.warn(line);
        else if (!(path === "/health" && status === 200)) console.log(line);
      });
    });

    return requestContext.run({ requestId }, () =>
      Promise.resolve()
        .then(() => listener(request, response))
        .catch((error: unknown) => {
          console.error(`Unhandled error while handling ${method} ${path}:\n${describeErrorWithStack(error)}`);
          if (!response.headersSent) {
            response.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            response.end(JSON.stringify({ error: "Internal server error" }));
          } else if (!response.writableEnded) {
            response.end();
          }
        }),
    );
  };
}

export function installProcessErrorLogging(): void {
  process.on("unhandledRejection", (reason) => {
    console.error(`Unhandled promise rejection:\n${describeErrorWithStack(reason)}`);
  });
  process.on("uncaughtException", (error) => {
    console.error(`Uncaught exception (exiting):\n${describeErrorWithStack(error)}`);
    process.exit(1);
  });
}

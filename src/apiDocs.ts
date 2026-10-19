import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./config.js";
import { describeError } from "./logging.js";
import { createOpenApiDocument } from "./openapi.js";

const assets: Record<string, string> = {
  "swagger-ui.css": "text/css; charset=utf-8",
  "swagger-ui-bundle.js": "application/javascript; charset=utf-8",
};
const initializer = `window.onload = function () {
  window.ui = SwaggerUIBundle({ url: '/api/openapi.json', dom_id: '#swagger-ui',
    deepLinking: true, validatorUrl: null, persistAuthorization: false });
};`;
const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>BT Auth Orchestrator API</title><link rel="stylesheet" href="/api/docs/swagger-ui.css"></head>
<body><div id="swagger-ui"></div><script src="/api/docs/swagger-ui-bundle.js"></script>
<script src="/api/docs/initializer.js"></script></body></html>`;

export function createApiDocsHandler(config: Config) {
  const document = JSON.stringify(createOpenApiDocument(config));
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    if (request.method !== "GET" && request.method !== "HEAD") return false;
    const path = (request.url ?? "").split("?")[0];
    let content: string | Buffer;
    let contentType: string;
    if (path === "/api/openapi.json" || path === "/openapi.json") {
      content = document;
      contentType = "application/json; charset=utf-8";
    } else if (["/docs", "/docs/", "/api/docs", "/api/docs/"].includes(path)) {
      content = page;
      contentType = "text/html; charset=utf-8";
    } else if (path === "/api/docs/initializer.js") {
      content = initializer;
      contentType = "application/javascript; charset=utf-8";
    } else {
      const filename = path.slice("/api/docs/".length);
      if (!path.startsWith("/api/docs/") || !Object.hasOwn(assets, filename)) return false;
      try {
        content = await readFile(join(dirname(require.resolve("swagger-ui-dist/package.json")), filename));
        contentType = assets[filename];
      } catch (error) {
        console.error(`API documentation asset ${filename} could not be read: ${describeError(error)}`);
        response.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(request.method === "HEAD" ? undefined : JSON.stringify({ error: "Unable to load API documentation assets" }));
        return true;
      }
    }
    response.writeHead(200, {
      "Content-Type": contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(request.method === "HEAD" ? undefined : content);
    return true;
  };
}

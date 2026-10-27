import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describeError } from "./logging.js";

// CONTRACT-010 §1: the browser admin console is static and public. Every
// action it performs is authorized by the existing API endpoints.
//
// The console files live in src/console/ and are copied to dist/console/ by
// `npm run build` (scripts/copy-console-assets.js). Request paths are matched
// against this fixed allow-list only and are never used to build a
// filesystem path: each entry maps a URL to a constant file name.
const CONSOLE_FILES: Record<string, { file: string; contentType: string }> = {
  "/admin/console": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/admin/console/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/admin/console/app.js": { file: "app.js", contentType: "application/javascript; charset=utf-8" },
  "/admin/console/theme.js": { file: "theme.js", contentType: "application/javascript; charset=utf-8" },
  "/admin/console/app.css": { file: "app.css", contentType: "text/css; charset=utf-8" },
};

export const ADMIN_CONSOLE_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Returns false for anything that is not an allow-listed console GET/HEAD, so it falls through to the generic 404. */
export function createAdminConsoleHandler(directory: string = join(__dirname, "console")) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    if (request.method !== "GET" && request.method !== "HEAD") return false;
    const path = (request.url ?? "").split("?")[0] ?? "";
    if (!Object.hasOwn(CONSOLE_FILES, path)) return false;
    const { file, contentType } = CONSOLE_FILES[path]!;
    let content: Buffer;
    try {
      content = await readFile(join(directory, file));
    } catch (error) {
      console.error(`Admin console file ${file} could not be read (run npm run build): ${describeError(error)}`);
      response.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : JSON.stringify({ error: "Unable to load the admin console" }));
      return true;
    }
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": ADMIN_CONSOLE_CONTENT_SECURITY_POLICY,
    });
    response.end(request.method === "HEAD" ? undefined : content);
    return true;
  };
}

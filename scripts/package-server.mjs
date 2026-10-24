import { cp, mkdir, chmod } from "node:fs/promises";
// Publish the already prerendered homepage as a real CDN index. API routes
// still use the Next.js server; opening the app needs no function invocation.
await cp(".next/server/app/index.html", "public/index.html");
await chmod("public/index.html", 0o644);

await mkdir(".next/standalone/.next", { recursive: true });
await cp("public", ".next/standalone/public", { recursive: true });
await cp(".next/static", ".next/standalone/.next/static", { recursive: true });
await cp(".server", ".next/standalone/.server", { recursive: true });

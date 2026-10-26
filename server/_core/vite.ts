import { createHash } from "crypto";
import express, { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import path from "path";

export async function setupVite(app: Express, server: Server) {
  // Loaded only here (development under tsx), so the production build never imports Vite or its plugins.
  const { createServer: createViteServer } = await import("vite");
  const configPath = path.resolve(import.meta.dirname, "../..", "vite.config.ts");
  const { default: viteConfig } = await import(configPath);
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "../..",
        "client",
        "index.html"
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${crypto.randomUUID()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

function staticPath(): string {
  return process.env.NODE_ENV === "development"
    ? path.resolve(import.meta.dirname, "../..", "dist", "public")
    : path.resolve(import.meta.dirname, "public");
}

/**
 * Identifies the built web app: Vite puts content hashes of every asset into index.html, so its own hash
 * changes with every build that changes anything. Null when there is no build (development with Vite).
 */
export function staticBuildId(): string | null {
  try { return createHash("sha256").update(fs.readFileSync(path.resolve(staticPath(), "index.html"))).digest("hex").slice(0, 16); } catch { return null; }
}

export function serveStatic(app: Express) {
  const distPath = staticPath();
  if (!fs.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }

  app.use(express.static(distPath));

  // fall through to index.html if the file doesn't exist
  app.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}

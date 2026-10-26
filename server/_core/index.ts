import "dotenv/config";
import express from "express";
import helmet from "helmet";
import { createServer } from "http";
import net from "net";
import { createCasambiApi } from "../api";
import { JsonLineCasambiBridge } from "../casambi/bridge";
import { CasambiService } from "../casambi/service";
import { EventHub } from "../events";
import { DurableScheduler } from "../scheduler";
import { SetupCode } from "../setupCode";
import { LocalStore } from "../store";
import { SwitchRuleRunner } from "../switchRules";
import { serveStatic, setupVite } from "./vite";

const production = process.env.NODE_ENV === "production";
const development = process.env.NODE_ENV === "development";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

/**
 * Refuses to run on the development fallback secrets, which would make tokens forgeable. Only an explicit
 * NODE_ENV=development skips this, so a missing or mistyped NODE_ENV on the Pi cannot weaken it.
 */
function assertProductionSecrets(): void {
  if (development) return;
  const missing = ["CASAMBI_ENCRYPTION_KEY", "CASAMBI_JWT_SECRET"].filter(name => {
    const value = process.env[name];
    return !value || value.startsWith("replace-with") || value === "development-only-change-me";
  });
  if (missing.length) throw new Error(`${missing.join(" and ")} must be set to unique secrets in /etc/casambi-bt-webui.env (re-run deploy/install.sh to generate them).`);
  const short = ["CASAMBI_ENCRYPTION_KEY", "CASAMBI_JWT_SECRET"].filter(name => process.env[name]!.length < 32);
  if (short.length) throw new Error(`${short.join(" and ")} must be at least 32 characters long.`);
}

async function startServer() {
  assertProductionSecrets();
  const app = express();
  app.disable("x-powered-by");
  // Vite's dev server injects inline scripts, so the strict policy only applies to the built app.
  if (!development) app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
        "img-src": ["'self'", "data:"],
        "connect-src": ["'self'"],
        "frame-ancestors": ["'none'"],
        // The appliance is usually reached over plain HTTP on the LAN; upgrading requests to HTTPS would break it.
        "upgrade-insecure-requests": null,
      },
    },
    // HSTS belongs on a TLS reverse proxy, not on a service that normally speaks plain HTTP.
    strictTransportSecurity: false,
  }));
  // Only behind a reverse proxy may X-Forwarded-For be trusted; otherwise any client could pick its own
  // address and bypass the rate limit (including on login).
  app.set("trust proxy", process.env.CASAMBI_TRUST_PROXY === "true" ? 1 : false);
  const server = createServer(app);
  const store = new LocalStore();
  const events = new EventHub();
  const bridge = new JsonLineCasambiBridge();
  const casambi = new CasambiService(store, bridge, events);
  const scheduler = new DurableScheduler(store, (command, actor) => casambi.control(command, actor).then(() => undefined), events);
  const switchRules = new SwitchRuleRunner(store, casambi, events);
  const setupCode = new SetupCode(store.dataDirectory, store.needsBootstrap());
  if (store.needsBootstrap()) console.log(development ? `First-run setup code: ${setupCode.reveal()}` : `First-run setup code written to ${setupCode.path} (deploy/install.sh prints it).`);
  casambi.onSwitchPress(press => void switchRules.handle(press));
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/v1", createCasambiApi({ store, service: casambi, events, scheduler, setupCode }));
  await casambi.initialize();
  scheduler.reload();
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  // In production the installer, health check, and users rely on the configured port; a busy port is an error.
  const port = production ? preferredPort : await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.on("error", error => { console.error(error); bridge.stop(); process.exit(1); });
  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
  // A signal handler replaces Node's default exit, so exit explicitly; open SSE streams would otherwise keep systemd waiting until SIGKILL.
  const shutdown = () => { bridge.stop(); process.exit(0); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

// Exit on a startup failure so systemd records it and restarts the service, instead of an idle process with no listener.
startServer().catch(error => { console.error(error); process.exit(1); });

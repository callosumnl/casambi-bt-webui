import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createCasambiApi } from "../api";
import { JsonLineCasambiBridge } from "../casambi/bridge";
import { CasambiService } from "../casambi/service";
import { EventHub } from "../events";
import { DurableScheduler } from "../scheduler";
import { LocalStore } from "../store";
import { SwitchRuleRunner } from "../switchRules";
import { serveStatic, setupVite } from "./vite";

const production = process.env.NODE_ENV === "production";

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

/** Refuses to run in production on the development fallback secrets, which would make tokens forgeable. */
function assertProductionSecrets(): void {
  if (!production) return;
  const missing = ["CASAMBI_ENCRYPTION_KEY", "CASAMBI_JWT_SECRET"].filter(name => {
    const value = process.env[name];
    return !value || value.startsWith("replace-with") || value === "development-only-change-me";
  });
  if (missing.length) throw new Error(`${missing.join(" and ")} must be set to unique secrets in /etc/casambi-bt-webui.env (re-run deploy/install.sh to generate them).`);
}

async function startServer() {
  assertProductionSecrets();
  const app = express();
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
  casambi.onSwitchPress(press => void switchRules.handle(press));
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/v1", createCasambiApi({ store, service: casambi, events, scheduler }));
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

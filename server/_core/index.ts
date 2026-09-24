import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createCasambiApi } from "../api";
import { JsonLineCasambiBridge } from "../casambi/bridge";
import { CasambiService } from "../casambi/service";
import { EventHub } from "../events";
import { DurableScheduler } from "../scheduler";
import { LocalStore } from "../store";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";

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

async function startServer() {
  const app = express();
  // The managed gateway and common Raspberry Pi reverse proxies add one trusted forwarding hop.
  app.set("trust proxy", 1);
  const server = createServer(app);
  const store = new LocalStore();
  const events = new EventHub();
  const bridge = new JsonLineCasambiBridge();
  const casambi = new CasambiService(store, bridge, events);
  const scheduler = new DurableScheduler(store, (command, actor) => casambi.control(command, actor).then(() => undefined), events);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);
  app.use("/api/v1", createCasambiApi({ store, service: casambi, events, scheduler }));
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  await casambi.initialize();
  scheduler.reload();
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
  // A signal handler replaces Node's default exit, so exit explicitly; open SSE streams would otherwise keep systemd waiting until SIGKILL.
  const shutdown = () => { bridge.stop(); process.exit(0); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

startServer().catch(console.error);

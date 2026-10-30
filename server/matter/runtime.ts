import { createSocket } from "dgram";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, normalize, sep } from "path";
import { Endpoint, Environment, Logger, ServerNode, VendorId } from "@matter/main";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";
import { FabricManager } from "@matter/main/protocol";
import type { FabricIndex } from "@matter/main/types";

/** The node id's UUID as 32 hex digits, for Matter fields limited to 32 characters. */
export const shortId = (id: string) => id.replace(/^casambi-/, "").replace(/-/g, "").slice(0, 32);

/** matter.js reports a failed start as an AggregateError ("Behaviors have errors"); the first cause says what is wrong. */
export function startError(error: unknown): string {
  const nested = (error as { errors?: unknown[] })?.errors;
  const first = Array.isArray(nested) && nested.length ? nested[0] : error;
  const message = first instanceof Error ? first.message : "Starting the Matter bridge failed.";
  return message.replace(/^Error initializing [^ ]+ Error: /, "");
}

export type MatterNodeConfig = { id: string; name: string; port: number; vendorId: number; productId: number; passcode: number; discriminator: number };
export type MatterFabric = { index: number; label: string; vendorId: number };

/** One running Matter node, as far as the bridge uses it; tests replace it. */
export interface MatterHost {
  start(): Promise<void>;
  close(): Promise<void>;
  pairingCodes(): { manualPairingCode: string; qrPairingCode: string };
  commissioned(): boolean;
  fabrics(): MatterFabric[];
  /** Opens a 15-minute window in which another controller can add the bridge (Matter allows several). */
  openPairingWindow(): Promise<void>;
  removeFabric(index: number): Promise<void>;
  /** Removes every fabric and all stored keys; the node comes back uncommissioned with the same setup code. */
  reset(): Promise<void>;
  onFabricsChanged(listener: (index: number, action: "added" | "deleted" | "updated") => void): void;
  /** The endpoint bridged lights are added to (phase 3). */
  aggregator(): Endpoint;
}

/** Creates Matter nodes; tests replace it. */
export interface MatterRuntime {
  create(config: MatterNodeConfig): Promise<MatterHost>;
  portAvailable(port: number): Promise<boolean>;
  /** The node's stored keys, fabrics, and endpoint numbers as path → base64, for a backup; null when there are none. */
  exportStorage(nodeId: string): Record<string, string> | null;
  /** Replaces the node's storage with a backup's; only while the node is closed. */
  importStorage(nodeId: string, files: Record<string, string>): void;
}

/** A relative path inside the storage folder, never one that leaves it. */
const safeRelative = (path: string) => { const clean = normalize(path); return clean && !clean.startsWith("..") && !clean.startsWith(sep) && !clean.includes(`..${sep}`) ? clean : null; };

/**
 * matter.js keeps the node's keys and fabrics in one process-wide storage folder, set before first use. Its own log
 * goes to the service log at "warn" by default: at "notice" it prints the setup code and QR code, which belong in the
 * Admin panel only. CASAMBI_MATTER_LOG_LEVEL overrides the level for troubleshooting.
 */
export function matterRuntime(storagePath: string, logLevel = process.env.CASAMBI_MATTER_LOG_LEVEL || "warn"): MatterRuntime {
  mkdirSync(storagePath, { recursive: true, mode: 0o700 });
  Environment.default.vars.set("storage.path", storagePath);
  Logger.level = logLevel as typeof Logger.level;
  return {
    async create(config) {
      const server = await ServerNode.create({
        id: config.id,
        network: { port: config.port },
        commissioning: { passcode: config.passcode, discriminator: config.discriminator },
        productDescription: { name: config.name, deviceType: AggregatorEndpoint.deviceType },
        basicInformation: {
          vendorName: "Casambi BT WebGUI", vendorId: VendorId(config.vendorId), productId: config.productId,
          productName: "Casambi bridge", productLabel: "Casambi bridge", nodeLabel: config.name,
          // Matter allows at most 32 characters for both; the node id is longer, so use its 32 hex digits.
          serialNumber: `CBT-${shortId(config.id).slice(0, 16)}`, uniqueId: shortId(config.id),
        },
      });
      const aggregator = new Endpoint(AggregatorEndpoint, { id: "aggregator" });
      await server.add(aggregator);
      return {
        start: () => server.start(),
        close: () => server.close(),
        pairingCodes: () => server.state.commissioning.pairingCodes,
        commissioned: () => server.lifecycle.isCommissioned,
        fabrics: () => Object.values(server.state.commissioning.fabrics).map(fabric => ({ index: Number(fabric.fabricIndex), label: fabric.label, vendorId: Number(fabric.rootVendorId) })),
        openPairingWindow: async () => { await server.act(agent => agent.commissioning.enterCommissionableMode()); },
        removeFabric: async index => {
          const fabric = server.env.get(FabricManager).maybeFor(index as FabricIndex);
          if (!fabric) throw new Error("That connection does not exist.");
          await fabric.leave();
        },
        reset: () => server.erase(),
        onFabricsChanged: listener => { server.events.commissioning.fabricsChanged.on((index, action) => listener(Number(index), action)); },
        aggregator: () => aggregator,
      };
    },
    exportStorage: nodeId => exportStorageFolder(join(storagePath, nodeId)),
    importStorage: (nodeId, files) => importStorageFolder(join(storagePath, nodeId), files),
    portAvailable: port => new Promise(resolve => {
      const probe = createSocket({ type: "udp6", reuseAddr: false });
      probe.once("error", () => { probe.close(); resolve(false); });
      probe.bind(port, () => probe.close(() => resolve(true)));
    }),
  };
}

/** A storage folder's files as relative path → base64, without matter.js's lock files; null when there are none. */
export function exportStorageFolder(folder: string): Record<string, string> | null {
  try {
    // matter.lock and matter.pid only mark an open storage; they must not come back on another Pi.
    const files = readdirSync(folder, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && entry.name !== "matter.lock" && entry.name !== "matter.pid");
    const paths = files.map(entry => join(entry.parentPath, entry.name));
    return paths.length ? Object.fromEntries(paths.map(path => [path.slice(folder.length + 1), readFileSync(path).toString("base64")])) : null;
  } catch { return null; }
}

/** Replaces a storage folder with exported files; paths that would leave the folder are skipped. */
export function importStorageFolder(folder: string, files: Record<string, string>): void {
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  for (const [path, content] of Object.entries(files)) {
    const relative = safeRelative(path);
    if (!relative || typeof content !== "string") continue;
    mkdirSync(dirname(join(folder, relative)), { recursive: true, mode: 0o700 });
    writeFileSync(join(folder, relative), Buffer.from(content, "base64"), { mode: 0o600 });
  }
}

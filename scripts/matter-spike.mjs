#!/usr/bin/env node
/**
 * Phase 0 of docs/MATTER_PLAN.md: a throw-away Matter bridge with test lamps, to check that Google Home (through a
 * Nest Hub) can commission and control a matter.js bridge on this network. It does not touch the running service.
 *
 *   node scripts/matter-spike.mjs [--lamps 1] [--port 5540] [--folder ~/matter-spike]
 *                                 [--vendor 0xFFF1] [--product 0x8000]
 *                                 [--api http://localhost:3000 --api-key cbt_… --unit 4]
 *
 * With --api, --api-key (a REST API key from Admin → Access) and --unit, the first test lamp switches and dims that
 * Casambi unit through the web app's REST API, so "Hey Google" really switches a lamp. Without them, commands are
 * only printed. Stop with Ctrl+C; delete the folder to start over (Google Home then sees a new device).
 */
import { randomInt } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import QRCode from "qrcode";
import { Endpoint, Environment, ServerNode, VendorId } from "@matter/main";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import { DimmableLightDevice } from "@matter/main/devices/dimmable-light";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";

const { values: options } = parseArgs({
  options: {
    lamps: { type: "string", default: "1" },
    port: { type: "string", default: "5540" },
    folder: { type: "string", default: join(homedir(), "matter-spike") },
    vendor: { type: "string", default: "0xFFF1" },
    product: { type: "string", default: "0x8000" },
    api: { type: "string" },
    "api-key": { type: "string" },
    unit: { type: "string" },
  },
});
const lampCount = Math.max(1, Math.min(200, Number(options.lamps)));
// Not "--storage": matter.js reads the command line too, and --storage would clash with its own storage.path.
const storage = resolve(options.folder);
mkdirSync(storage, { recursive: true, mode: 0o700 });

/** Matter forbids these setup passcodes. */
const FORBIDDEN = new Set([0, 11111111, 22222222, 33333333, 44444444, 55555555, 66666666, 77777777, 88888888, 99999999, 12345678, 87654321]);
/** Passcode, discriminator, and node id are made once and kept, so a restart keeps the commissioned bridge. */
function identity() {
  const file = join(storage, "spike.json");
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { /* first run */ }
  let passcode;
  do { passcode = randomInt(1, 99999999); } while (FORBIDDEN.has(passcode));
  const created = { passcode, discriminator: randomInt(0, 4096), uniqueId: `casambi-spike-${randomInt(1e9)}` };
  writeFileSync(file, JSON.stringify(created), { mode: 0o600 });
  return created;
}
const { passcode, discriminator, uniqueId } = identity();

const forward = options.api && options["api-key"] && options.unit
  ? async (command) => {
    const response = await fetch(`${options.api.replace(/\/$/, "")}/api/v1/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": options["api-key"], Prefer: "return=minimal" },
      body: JSON.stringify({ targetType: "unit", targetId: Number(options.unit), ...command }),
    });
    console.log(`  → Casambi unit ${options.unit}: ${JSON.stringify(command)} (HTTP ${response.status})`);
  }
  : null;

Environment.default.vars.set("storage.path", storage);
const server = await ServerNode.create({
  id: uniqueId,
  network: { port: Number(options.port) },
  commissioning: { passcode, discriminator },
  productDescription: { name: "Casambi-bt-webui", deviceType: AggregatorEndpoint.deviceType },
  basicInformation: {
    vendorName: "Casambi BT WebGUI", vendorId: VendorId(Number(options.vendor)),
    productName: "Casambi bridge (test)", productLabel: "Casambi bridge (test)", nodeLabel: "Casambi-bt-webui",
    productId: Number(options.product), serialNumber: `sn-${uniqueId}`, uniqueId,
  },
});
const aggregator = new Endpoint(AggregatorEndpoint, { id: "aggregator" });
await server.add(aggregator);

for (let index = 1; index <= lampCount; index += 1) {
  const name = lampCount === 1 ? "Testlamp" : `Testlamp ${index}`;
  const lamp = new Endpoint(DimmableLightDevice.with(BridgedDeviceBasicInformationServer), {
    id: `lamp-${index}`,
    bridgedDeviceBasicInformation: { nodeLabel: name, productName: "Casambi lamp (test)", productLabel: "Casambi lamp (test)", serialNumber: `sn-${uniqueId}-${index}`, uniqueId: `${uniqueId}-${index}`, reachable: true },
  });
  await aggregator.add(lamp);
  const casambi = index === 1 ? forward : null;
  lamp.events.onOff.onOff$Changed.on(on => {
    console.log(`${new Date().toLocaleTimeString()} ${name}: ${on ? "ON" : "OFF"}`);
    void casambi?.({ operation: on ? "on" : "off" }).catch(error => console.error(`  Casambi: ${error.message}`));
  });
  lamp.events.levelControl.currentLevel$Changed.on(level => {
    if (level === null) return;
    console.log(`${new Date().toLocaleTimeString()} ${name}: level ${level}/254 (${Math.round((level / 254) * 100)} %)`);
    // Matter levels are 1–254, Casambi levels 0–255.
    void casambi?.({ operation: "set_level", value: Math.max(1, Math.round((level / 254) * 255)) }).catch(error => console.error(`  Casambi: ${error.message}`));
  });
}

await server.start();
const { manualPairingCode, qrPairingCode } = server.state.commissioning.pairingCodes;
console.log(`\nMatter test bridge "Casambi-bt-webui" with ${lampCount} test lamp(s), vendor ${options.vendor}, product ${options.product}, UDP port ${options.port}.`);
console.log(`Storage: ${storage}`);
if (server.lifecycle.isCommissioned) console.log("Already added to a Matter controller (Google Home). Delete the storage folder to start over.\n");
else {
  console.log("\nIn the Google Home app: + → Device → Matter-enabled device, then scan this code:\n");
  console.log(await QRCode.toString(qrPairingCode, { type: "terminal", small: true }));
  console.log(`Or type the setup code: ${manualPairingCode}\n`);
}
server.events.commissioning.fabricsChanged.on(() => console.log(`${new Date().toLocaleTimeString()} Matter fabrics changed: ${server.state.commissioning.fabrics ? Object.values(server.state.commissioning.fabrics).map(fabric => fabric.label || "unnamed").join(", ") : "?"}`));

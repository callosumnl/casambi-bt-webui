/**
 * Verifies a deployed non-mock bridge through its authenticated REST interface.
 * Supply CASAMBI_JWT and optionally CASAMBI_BASE_URL before running this script.
 */
const baseUrl = process.env.CASAMBI_BASE_URL || "http://127.0.0.1:3000/api/v1";
const token = process.env.CASAMBI_JWT;

if (!token) {
  console.error("Set CASAMBI_JWT to an admin or user JWT before running this hardware verification.");
  process.exit(2);
}

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || `HTTP ${response.status} at ${path}`);
  return body;
}

const network = await get("/network");
if (!network.connected) throw new Error("Bridge is not connected to a live Casambi network.");
console.log(`Connected to ${network.network?.name || network.network?.id || "Casambi network"}: ${network.units.length} unit(s), ${network.groups.length} group(s), ${network.scenes.length} scene(s).`);

const sensors = await get("/sensors");
if (sensors.length === 0) {
  console.log("No SENSOR controls were reported by this network.");
} else {
  console.table(sensors.map(sensor => ({ device: sensor.deviceName, label: sensor.label, value: sensor.value, unit: sensor.unit })));
  console.log("Raw SENSOR values appear after a state packet for the corresponding fixture. Trigger a physical sensor change or wait for an update if a value is null.");
}

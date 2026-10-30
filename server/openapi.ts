import { z } from "zod";
import {
  apiKeyCreateSchema, awayDateSetSchema, backupCreateSchema, bootstrapSchema, homekitAccessoriesSchema, homekitSettingsSchema, matterAccessoriesSchema, matterSettingsSchema, serverSettingsSchema, notificationWebhookSchema, configSchema, credentialsSchema, deviceMetadataSchema, deviceRoomsSchema, fadeBodySchema, roomCreateSchema,
  roomDefaultBrightnessSchema, roomRenameSchema, sceneCreateSchema, sceneRenameSchema, schedulePatchSchema, scheduleSchema, userCreateSchema, userUpdateSchema,
} from "./apiSchemas";
import { controlRequestSchema, groupSchema, networkSnapshotSchema, sceneSchema, unitSchema } from "./casambi/types";
import { switchRulePatchSchema, switchRuleSchema } from "./switchRules";

type JsonSchema = Record<string, unknown>;
type Access = "public" | "user" | "admin";
type Response = { description: string; schema?: string | JsonSchema; contentType?: string };
/** One REST operation. `body` and string `schema` values name a component in `components.schemas`. */
type Operation = {
  method: "get" | "post" | "put" | "patch" | "delete"; path: string; tag: string; summary: string; description?: string;
  access: Access; body?: string; bodyRequired?: boolean; query?: Array<{ name: string; description: string; schema: JsonSchema }>;
  /** A request body that is not JSON, e.g. an uploaded file; `body` then names its schema. */
  bodyContentType?: string; headers?: Array<{ name: string; description: string; required: boolean }>;
  responses: Record<string, Response>;
};

/** zod → JSON Schema (2020-12, which OpenAPI 3.1 uses directly). `input` describes what a request may send. */
function fromZod(schema: z.ZodType, io: "input" | "output" = "input"): JsonSchema {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: "any" }) as JsonSchema;
  return rest;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const list = (name: string) => ({ type: "array", items: ref(name) });
const nullable = (schema: JsonSchema) => ({ anyOf: [schema, { type: "null" }] });
const id = { type: "integer", minimum: 1 };
const timestamp = { type: "string", format: "date-time" };
const role = { type: "string", enum: ["admin", "user"] };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", properties, required });

const schemas: Record<string, JsonSchema> = {
  // Requests: generated from the schemas the API validates with.
  Credentials: fromZod(credentialsSchema),
  Bootstrap: fromZod(bootstrapSchema),
  UserCreate: fromZod(userCreateSchema),
  UserUpdate: { ...fromZod(userUpdateSchema), examples: [{ role: "user" }, { password: "a-new-long-password" }] },
  RoomRename: fromZod(roomRenameSchema),
  ApiKeyCreate: fromZod(apiKeyCreateSchema),
  CasambiConfigUpdate: { ...fromZod(configSchema), examples: [{ networkAddress: "AB:CD:EF:01:23:45", networkPassword: "network password", pollingEnabled: true, pollingIntervalSeconds: 60 }] },
  ControlRequest: { ...fromZod(controlRequestSchema), examples: [{ targetType: "unit", targetId: 1, operation: "set_level", value: 128 }, { targetType: "group", targetId: 2, operation: "off", fadeDurationMs: 2000 }, { targetType: "local_scene", targetId: 3, operation: "activate_scene" }] },
  Fade: fromZod(fadeBodySchema),
  LightSceneCreate: { ...fromZod(sceneCreateSchema), examples: [{ name: "Dinner", scope: { type: "room", id: 1 } }] },
  LightSceneRename: fromZod(sceneRenameSchema),
  ScheduleCreate: { ...fromZod(scheduleSchema), examples: [{ name: "Evening", cronExpression: "0 18 * * 1-5", timezone: "Europe/Amsterdam", command: { targetType: "network", operation: "set_level", value: 128, fadeDurationMs: 5000 } }, { name: "Sunset", timezone: "Europe/Amsterdam", solar: { event: "sunset", offsetMinutes: -15 }, command: { targetType: "local_scene", targetId: 3, operation: "activate_scene" } }] },
  ScheduleUpdate: fromZod(schedulePatchSchema),
  AwayDateSetCreate: fromZod(awayDateSetSchema),
  AwayDateSetUpdate: fromZod(awayDateSetSchema.partial()),
  RoomCreate: fromZod(roomCreateSchema),
  RoomDefaultBrightness: fromZod(roomDefaultBrightnessSchema),
  DeviceMetadata: fromZod(deviceMetadataSchema),
  DeviceRooms: fromZod(deviceRoomsSchema),
  SwitchRuleCreate: { ...fromZod(switchRuleSchema), examples: [{ name: "Kitchen toggle", unitId: 2, button: 4, trigger: "tap", command: { targetType: "room", targetId: 1, operation: "toggle" } }] },
  SwitchRuleUpdate: fromZod(switchRulePatchSchema),
  // Responses.
  Error: object({
    error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, fields: { description: "Per-field validation messages (validation errors only)." } }, required: ["code", "message"] },
    requestId: { type: "string" },
  }, ["error"]),
  Health: object({ status: { type: "string", const: "ok" }, bootstrapRequired: { type: "boolean", description: "True until the first admin account exists." }, eventClients: { type: "integer" }, build: { type: ["string", "null"], description: "Identifies the web app build being served; it changes with every update. Null in development." } }),
  User: object({ id, username: { type: "string" }, role, createdAt: timestamp }),
  EventTicket: object({ ticket: { type: "string" }, expiresInSeconds: { type: "integer", const: 60 } }),
  Session: object({ token: { type: "string", description: "JWT for the Authorization: Bearer header; valid for 8 hours." }, user: ref("User") }),
  Principal: object({ principal: object({ kind: { type: "string", enum: ["user", "api_key"] }, id, name: { type: "string" }, role }) }),
  Unit: fromZod(unitSchema, "output"),
  Group: fromZod(groupSchema, "output"),
  CasambiScene: fromZod(sceneSchema, "output"),
  Room: object({ id, name: { type: "string" }, sortOrder: { type: "integer" }, defaultBrightnessPercent: { type: "integer", minimum: 0, maximum: 100 } }),
  ConnectionStatus: {
    type: "object", required: ["phase"], description: "What the Pi is doing about the Casambi connection.",
    properties: { phase: { type: "string", enum: ["idle", "connecting", "connected", "retrying", "failed"] }, attempt: { type: "integer" }, nextRetryAt: timestamp, lastError: { type: "string" } },
  },
  NetworkSnapshot: {
    allOf: [fromZod(networkSnapshotSchema, "output"), { type: "object", properties: { rooms: list("Room"), connection: ref("ConnectionStatus") } }],
    description: "Units, groups, and Casambi scenes with local names and room assignments. Levels are 0-255.",
  },
  Sensor: object({ deviceId: { type: "integer" }, deviceName: { type: "string" }, label: { type: "string" }, value: nullable({ type: "number" }), unit: nullable({ type: "string" }) }),
  SystemCheck: object({
    generatedAt: timestamp,
    checks: { type: "array", items: object({ id: { type: "string" }, title: { type: "string" }, status: { type: "string", enum: ["ok", "warn", "fail", "info"] }, detail: { type: "string" }, advice: { type: "string" } }, ["id", "title", "status", "detail"]) },
    versions: { type: "object", description: "Application version and commit, Node.js, and the Python Bluetooth libraries.", additionalProperties: { type: ["string", "null"] } },
  }),
  UpdateStatus: object({
    supported: { type: "boolean" },
    running: object({ version: nullable({ type: "string" }), commit: nullable({ type: "string" }) }),
    pending: object({ check: { type: "boolean" }, apply: { type: "boolean" } }),
    status: { type: "object", description: "As written by deploy/update.sh; empty before the first check.", properties: { state: { type: "string" }, message: nullable({ type: "string" }), current: nullable({ type: "string" }), latest: nullable({ type: "string" }), behind: nullable({ type: "integer" }), changes: { type: "array", items: { type: "string" } }, checkedAt: nullable({ type: "string" }), logTail: nullable({ type: "string" }) } },
  }),
  BackupCreate: fromZod(backupCreateSchema),
  ServerSettingsUpdate: fromZod(serverSettingsSchema),
  NotificationWebhook: fromZod(notificationWebhookSchema),
  HomeKitSettings: fromZod(homekitSettingsSchema),
  HomeKitAccessories: fromZod(homekitAccessoriesSchema),
  MatterSettings: fromZod(matterSettingsSchema),
  MatterAccessories: fromZod(matterAccessoriesSchema),
  MatterStatus: object({
    enabled: { type: "boolean" }, name: { type: "string" }, port: { type: "integer" }, vendorId: { type: "integer" }, productId: { type: "integer" },
    state: { type: "string", enum: ["disabled", "starting", "running", "failed"] },
    error: nullable({ type: "string", description: "Why the bridge could not start, for example a port in use." }),
    commissioned: { type: "boolean", description: "Whether a Matter controller (Google Home) has added the bridge." },
    fabrics: { type: "array", description: "The ecosystems that added the bridge.", items: object({ index: { type: "integer" }, owner: { type: "string", description: "Google Home, Apple Home, iPhone (Apple keychain), Amazon Alexa, SmartThings, or the fabric's label or vendor id." }, vendorId: { type: "integer", description: "The fabric's root vendor id; 0x1384 is an iPhone's own Matter fabric, through which the Google Home app on an iPhone adds the bridge." } }) },
    pairingWindowUntil: nullable({ ...timestamp, description: "Until when another ecosystem can add the already paired bridge." }),
    manualPairingCode: nullable({ type: "string", description: "The 11-digit setup code, while the bridge can be added." }),
    qrPairingCode: nullable({ type: "string", description: "The MT: setup payload, while the bridge can be added." }),
    qrSvg: nullable({ type: "string", description: "The setup payload as a QR code (SVG) for the Google Home app." }),
    lights: { type: "integer", description: "Lamps, Casambi groups, rooms, and scenes the bridge shows." },
    accessories: { type: "array", description: "Everything Google Home can show, as last seen on the connected network, and whether it does (separate from HomeKit's list).", items: object({ key: { type: "string" }, kind: { type: "string", enum: ["unit", "group", "room", "scene", "local_scene", "switch"] }, name: { type: "string" }, shown: { type: "boolean" } }) },
  }),
  Notifications: object({
    notifications: { type: "array", description: "Newest first, at most 50: id, kind (connection.lost, connection.restored, timer.failed, timer.unusable, update.failed), severity (info, warning, error), title, message, createdAt, readAt.", items: { type: "object" } },
    unread: { type: "integer" },
    webhook: { type: "object", description: "configured, and the host of the webhook URL (the URL itself is not returned)." },
  }),
  WebhookTest: object({ ok: { type: "boolean" }, status: { type: ["integer", "null"] }, message: { type: "string" } }),
  ServerSettings: object({
    supported: { type: "boolean", description: "Whether changing these settings from the app is set up (by deploy/install.sh)." },
    port: { type: "integer" }, trustProxy: { type: "boolean" }, pending: { type: "boolean" },
    status: { type: "object", description: "What deploy/apply-settings.sh last reported: state (applying, applied, rolled_back, failed), message, at." },
    readOnly: { type: "object", description: "Settings that can only be changed in /etc/casambi-bt-webui.env." },
  }),
  HomeKitStatus: object({
    enabled: { type: "boolean" }, name: { type: "string" }, port: { type: "integer" },
    state: { type: "string", enum: ["disabled", "starting", "published", "failed"] },
    error: nullable({ type: "string", description: "Why publishing failed, for example a port in use." }),
    advertised: { type: "boolean", description: "Whether the bridge is announced on the network (mDNS), so the Home app can find it." },
    advertiser: { type: "string", description: "The mDNS advertiser: avahi on Linux, ciao elsewhere, or CASAMBI_HOMEKIT_ADVERTISER." },
    pincode: { type: "string", description: "The HomeKit setup code (123-45-678)." },
    setupUri: nullable({ type: "string", description: "X-HM:// setup payload, while published." }),
    qrSvg: nullable({ type: "string", description: "The setup payload as a QR code (SVG) for the Home app, while published." }),
    pairings: { type: "integer", description: "Number of paired Apple Home controllers." },
    lights: { type: "integer", description: "Accessories shown in HomeKit: lamps, Casambi groups, and rooms as lights, scenes as switches." },
    accessories: { type: "array", description: "Everything HomeKit can show, as last seen on the connected network, and whether it does.", items: object({ key: { type: "string" }, kind: { type: "string", enum: ["unit", "group", "room", "scene", "local_scene", "switch"] }, name: { type: "string" }, shown: { type: "boolean" } }) },
    lightsNotShown: { type: "integer", description: "Lights that did not fit: HomeKit allows 149 accessories per bridge." },
  }),
  BackupFile: { type: "string", contentMediaType: "application/octet-stream", description: "A backup file as downloaded from POST /admin/backup." },
  DiscoveredNetwork: object({ address: { type: "string", description: "BLE address of a Casambi network endpoint in range." }, rssi: nullable({ type: "integer", description: "Signal strength in dBm (closer to 0 is stronger); null when the scan could not measure it." }) }),
  LightScene: object({
    id, name: { type: "string" },
    scope: object({ type: { type: "string", enum: ["group", "room", "network"] }, id: nullable({ type: "integer" }) }),
    lamps: { type: "array", items: object({ unitId: { type: "integer" }, level: { type: "integer", minimum: 0, maximum: 255, description: "0 = off." }, temperature: nullable({ type: "integer", description: "Kelvin." }) }) },
    createdAt: timestamp, updatedAt: timestamp,
  }),
  AwayDateSet: object({ id, name: { type: "string" }, dates: { type: "array", items: { type: "string", format: "date" } }, createdAt: timestamp, updatedAt: timestamp }),
  Schedule: object({
    id, name: { type: "string" }, cronExpression: { type: "string" }, timezone: { type: "string" }, command: ref("ControlRequest"),
    solar: nullable(object({ event: { type: "string", enum: ["sunrise", "sunset"] }, offsetMinutes: { type: "integer" } })),
    holidayDates: { type: "array", items: { type: "string", format: "date" } }, awayDateSetId: nullable({ type: "integer" }), awayDateSet: nullable(ref("AwayDateSet")),
    enabled: { type: "boolean" }, ownerUserId: { type: "integer" }, createdAt: timestamp, updatedAt: timestamp,
    lastRunKey: nullable({ type: "string" }), lastRunAt: nullable(timestamp), nextRunAt: nullable(timestamp),
  }),
  CasambiConfig: object({
    networkAddress: nullable({ type: "string" }), networkUuid: nullable({ type: "string" }), btAdapter: nullable({ type: "string" }), forceOffline: { type: "boolean" }, fastWrites: { type: "boolean", description: "Experimental write-without-response mode." },
    pollingEnabled: { type: "boolean" }, pollingIntervalSeconds: { type: "integer" }, solarLatitude: nullable({ type: "number" }), solarLongitude: nullable({ type: "number" }),
    hasApiKey: { type: "boolean", description: "Secrets are never returned, only whether one is stored." }, hasNetworkPassword: { type: "boolean" },
  }),
  WorkerState: object({
    running: { type: "boolean" }, pid: nullable({ type: "integer" }),
    busy: nullable(object({ command: { type: "string" }, forMs: { type: "integer" } })), lastAnswerAt: nullable(timestamp), restarts: { type: "integer" },
    bluetooth: nullable(object({
      commands: { type: "integer", description: "Light commands sent since the worker supervisor started." }, recent: { type: "integer", description: "Commands in the summary (the last 200)." },
      lastMs: { type: "number" }, medianMs: { type: "number" }, p95Ms: { type: "number" }, maxMs: { type: "number" },
      fastWrites: { type: "boolean", description: "Whether these commands went out without response. The summary restarts when the mode changes." },
    })),
  }),
  SwitchPress: object({
    unitId: nullable({ type: "integer" }), button: nullable({ type: "integer" }),
    trigger: nullable({ type: "string", enum: ["tap", "hold", "release_after_hold"], description: "Null for raw activity that never drives a rule." }),
    raw: { type: "object", description: "Upstream message fields for diagnosis." }, at: timestamp,
  }),
  SwitchRule: object({ id, name: { type: "string" }, unitId: { type: "integer" }, button: { type: "integer" }, trigger: { type: "string", enum: ["tap", "hold", "release_after_hold"] }, command: { type: "object" }, enabled: { type: "boolean" }, createdAt: timestamp, updatedAt: timestamp, lastTriggeredAt: nullable(timestamp) }),
  ApiKey: object({ id, label: { type: "string" }, prefix: { type: "string" }, role, createdAt: timestamp, lastUsedAt: nullable(timestamp), revokedAt: nullable(timestamp), expiresAt: nullable(timestamp) }),
  ApiKeyCreated: { allOf: [ref("ApiKey"), object({ token: { type: "string", description: "The full key, shown only in this response. Send it as X-API-Key." } })] },
  AuditEntry: object({ id: { type: "integer" }, actor: { type: "string" }, action: { type: "string" }, detail: { type: "object" }, createdAt: timestamp }),
};

const snapshot: Response = { description: "The network after the command.", schema: "NetworkSnapshot" };
const noContent: Response = { description: "Done." };

const operations: Operation[] = [
  // System and sign-in.
  { method: "get", path: "/health", tag: "System", summary: "Service health", access: "public", responses: { 200: { description: "The service is up.", schema: "Health" } } },
  { method: "get", path: "/openapi.json", tag: "System", summary: "This OpenAPI document", access: "public", responses: { 200: { description: "OpenAPI 3.1 document.", schema: { type: "object" } } } },
  { method: "post", path: "/auth/bootstrap", tag: "Authentication", summary: "Create the first admin", description: "Only works while no account exists. `setupCode` is the one-time code that deploy/install.sh prints (also in `setup-code` next to the database).", access: "public", body: "Bootstrap", responses: { 201: { description: "Admin created and signed in.", schema: "Session" }, 403: { description: "The setup code is not correct.", schema: "Error" }, 409: { description: "An administrator already exists.", schema: "Error" } } },
  { method: "post", path: "/auth/login", tag: "Authentication", summary: "Sign in", description: "Limited to 10 failed attempts per 5 minutes per client address.", access: "public", body: "Credentials", responses: { 200: { description: "Signed in.", schema: "Session" }, 401: { description: "Username or password is invalid.", schema: "Error" }, 429: { description: "Too many failed attempts; try again later.", schema: "Error" } } },
  { method: "post", path: "/auth/event-ticket", tag: "Authentication", summary: "Get an event-stream ticket", description: "A token that is valid for 60 seconds and only opens `GET /events?ticket=…`. For signed-in users; API keys use the X-API-Key header on /events instead.", access: "user", responses: { 200: { description: "The ticket.", schema: "EventTicket" }, 422: { description: "Called with an API key.", schema: "Error" } } },
  { method: "get", path: "/auth/me", tag: "Authentication", summary: "Who am I", access: "user", responses: { 200: { description: "The authenticated user or API key.", schema: "Principal" } } },
  {
    method: "get", path: "/events", tag: "System", summary: "Live event stream (SSE)", access: "user",
    description: "Server-Sent Events. Send the Authorization or X-API-Key header, or (browsers, whose EventSource cannot set headers) a one-minute `ticket` from `POST /auth/event-ticket`. Events: `connected`, `bridge`, `connection.status`, `unit.state`, `network.snapshot`, `switch`, `switch_rule.executed`, `switch_rule.failed`, `local_scenes.changed`, `schedule.executed`, `schedule.failed`, `schedule.skipped_holiday`. Each `data` is JSON `{ type, payload, at }`, except `connected`, whose data is `{ id, build, at }` (`build` as in `/health`; a page can reload when it changes). `switch` and `switch_rule.*` go to admins only, `schedule.*` to admins and the timer's owner. At most 10 streams per account or API key: opening another closes the oldest.",
    query: [{ name: "ticket", description: "Event ticket from `POST /auth/event-ticket`, as an alternative to the headers.", schema: { type: "string" } }],
    responses: { 200: { description: "An open event stream.", contentType: "text/event-stream", schema: { type: "string" } } },
  },
  // Network and control.
  { method: "get", path: "/network", tag: "Network", summary: "Network state", description: "Returns the last known state at once.", access: "user", query: [{ name: "fresh", description: "`1` waits for a new snapshot from the Bluetooth bridge instead.", schema: { type: "string", enum: ["1"] } }], responses: { 200: { description: "Network state.", schema: "NetworkSnapshot" } } },
  { method: "get", path: "/devices", tag: "Network", summary: "Units", description: "All units, including switches and sensors; lamps report a controllable capability.", access: "user", responses: { 200: { description: "Units.", schema: list("Unit") } } },
  { method: "get", path: "/groups", tag: "Network", summary: "Casambi groups", access: "user", responses: { 200: { description: "Groups.", schema: list("Group") } } },
  { method: "get", path: "/scenes", tag: "Network", summary: "Scenes stored in the Casambi network", access: "user", responses: { 200: { description: "Scenes.", schema: list("CasambiScene") } } },
  { method: "get", path: "/sensors", tag: "Network", summary: "Sensor readings", description: "Raw values; fixture-specific units are not documented upstream.", access: "user", responses: { 200: { description: "Readings.", schema: list("Sensor") } } },
  { method: "get", path: "/rooms", tag: "Network", summary: "Rooms", access: "user", responses: { 200: { description: "Rooms.", schema: list("Room") } } },
  { method: "post", path: "/control", tag: "Control", summary: "Control lamps", description: "One command for a unit, group, room, the whole network, or a scene. Levels are 0-255. Send `Prefer: return=minimal` to get 204 without the snapshot.", access: "user", body: "ControlRequest", bodyRequired: true, responses: { 200: snapshot, 204: { description: "Done (with Prefer: return=minimal)." } } },
  { method: "post", path: "/devices/{id}/on", tag: "Control", summary: "Turn a unit on", access: "user", responses: { 200: snapshot } },
  { method: "post", path: "/devices/{id}/off", tag: "Control", summary: "Turn a unit off", access: "user", responses: { 200: snapshot } },
  { method: "post", path: "/scenes/{id}/activate", tag: "Control", summary: "Activate a Casambi scene", access: "user", responses: { 200: snapshot } },
  { method: "post", path: "/rooms/{id}/apply-default", tag: "Control", summary: "Apply a room's default brightness", access: "user", body: "Fade", responses: { 200: snapshot } },
  // Scenes saved on the Pi.
  { method: "get", path: "/local-scenes", tag: "Scenes", summary: "Saved scenes", access: "user", responses: { 200: { description: "Scenes.", schema: list("LightScene") } } },
  { method: "post", path: "/local-scenes", tag: "Scenes", summary: "Save the current lights as a scene", description: "Captures each lamp of the group, room, or whole network (`id` null).", access: "user", body: "LightSceneCreate", bodyRequired: true, responses: { 201: { description: "Scene saved.", schema: "LightScene" } } },
  { method: "post", path: "/local-scenes/{id}/capture", tag: "Scenes", summary: "Update a scene to the current lights", access: "user", responses: { 200: { description: "Scene updated.", schema: "LightScene" } } },
  { method: "patch", path: "/local-scenes/{id}", tag: "Scenes", summary: "Rename a scene", access: "user", body: "LightSceneRename", bodyRequired: true, responses: { 200: { description: "Scene renamed.", schema: "LightScene" } } },
  { method: "delete", path: "/local-scenes/{id}", tag: "Scenes", summary: "Delete a scene", description: "Refused while timers or switch rules use it.", access: "user", responses: { 204: noContent, 409: { description: "Still in use; the message names the users.", schema: "Error" } } },
  { method: "post", path: "/local-scenes/{id}/apply", tag: "Scenes", summary: "Apply a scene", access: "user", body: "Fade", responses: { 200: snapshot } },
  // Timers.
  { method: "get", path: "/schedules", tag: "Timers", summary: "Timers", description: "Admins see all timers, users their own.", access: "user", responses: { 200: { description: "Timers.", schema: list("Schedule") } } },
  { method: "post", path: "/schedules", tag: "Timers", summary: "Create a timer", description: "A five-field cron time, or `solar` for sunrise/sunset (needs the admin-configured location).", access: "user", body: "ScheduleCreate", bodyRequired: true, responses: { 201: { description: "Timer created.", schema: "Schedule" } } },
  { method: "patch", path: "/schedules/{id}", tag: "Timers", summary: "Update a timer", description: "Only the fields sent are changed.", access: "user", body: "ScheduleUpdate", bodyRequired: true, responses: { 200: { description: "Timer updated.", schema: "Schedule" } } },
  { method: "delete", path: "/schedules/{id}", tag: "Timers", summary: "Delete a timer", access: "user", responses: { 204: noContent } },
  { method: "get", path: "/away-date-sets", tag: "Timers", summary: "Away-date sets", access: "user", responses: { 200: { description: "Sets.", schema: list("AwayDateSet") } } },
  // Administration: bridge.
  { method: "get", path: "/admin/config", tag: "Admin: bridge", summary: "Bridge settings", access: "admin", responses: { 200: { description: "Settings without secrets.", schema: "CasambiConfig" } } },
  { method: "put", path: "/admin/config", tag: "Admin: bridge", summary: "Change bridge settings", description: "Omitted fields keep their value; an empty secret clears it.", access: "admin", body: "CasambiConfigUpdate", bodyRequired: true, responses: { 200: { description: "Saved.", schema: "CasambiConfig" } } },
  { method: "get", path: "/admin/diagnostics", tag: "Admin: bridge", summary: "System check", description: "Checks Bluetooth, Wi-Fi interference, the Casambi connection, the clock, storage, temperature, and power, each with advice. Reads the system without privileges; checks that cannot be read report `info`.", access: "admin", responses: { 200: { description: "The checks and versions.", schema: "SystemCheck" } } },
  { method: "get", path: "/admin/diagnostics/bundle", tag: "Admin: bridge", summary: "Download a diagnostics file", description: "A JSON file with the checks, the facts behind them, versions, the worker state, the safe configuration, and the last 300 audit entries, for whoever helps troubleshoot. Contains no passwords or keys.", access: "admin", responses: { 200: { description: "The diagnostics file (attachment).", schema: { type: "object" } } } },
  { method: "post", path: "/admin/backup", tag: "Admin: bridge", summary: "Download a backup", description: "Everything on the Pi (accounts, API keys, Casambi settings including the network password, rooms, names, timers, scenes, switch rules, away dates, audit log) in one file, encrypted with the passphrase. It can be restored on another Pi; keep the passphrase, it cannot be recovered.", access: "admin", body: "BackupCreate", bodyRequired: true, responses: { 200: { description: "The backup file (attachment).", schema: { type: "object" } } } },
  { method: "post", path: "/admin/restore", tag: "Admin: bridge", summary: "Restore a backup", description: "Replaces all data with the backup. Send the file as `application/octet-stream` with its passphrase in `X-Backup-Passphrase`. Every session ends (sign in with an account from the backup); timers reload and the bridge reconnects with the restored settings.", access: "admin", body: "BackupFile", bodyContentType: "application/octet-stream", bodyRequired: true, headers: [{ name: "X-Backup-Passphrase", description: "The passphrase the backup was made with.", required: true }], responses: { 200: { description: "Restored.", schema: object({ restored: object({ createdAt: timestamp, users: { type: "integer" }, rooms: { type: "integer" }, timers: { type: "integer" } }), signInAgain: { type: "boolean" } }) }, 422: { description: "Not a backup, a wrong passphrase, or a damaged file.", schema: "Error" } } },
  { method: "get", path: "/admin/notifications", tag: "Admin: bridge", summary: "Notifications", description: "Problems that need an administrator: a Bluetooth connection down for 5 minutes (and its recovery), failing or unusable timers, and failed updates. New ones also arrive live as `notification` events.", access: "admin", responses: { 200: { description: "Notifications and the webhook state.", schema: "Notifications" } } },
  { method: "post", path: "/admin/notifications/read", tag: "Admin: bridge", summary: "Mark all notifications read", access: "admin", responses: { 204: { description: "Marked." } } },
  { method: "put", path: "/admin/notifications/webhook", tag: "Admin: bridge", summary: "Set the notification webhook", description: "Every new notification is POSTed there as JSON (`text`, `title`, `message`, `severity`, `kind`, `at`, `host`). Redirects are not followed.", access: "admin", body: "NotificationWebhook", bodyRequired: true, responses: { 204: { description: "Saved." }, 422: { description: "Not an http(s) URL.", schema: "Error" } } },
  { method: "post", path: "/admin/notifications/test", tag: "Admin: bridge", summary: "Send a test notification to the webhook", access: "admin", responses: { 200: { description: "What the webhook answered.", schema: "WebhookTest" }, 422: { description: "No webhook URL is set.", schema: "Error" } } },
  { method: "get", path: "/admin/server-settings", tag: "Admin: bridge", summary: "Server settings", description: "The port and reverse-proxy setting this process runs with, the read-only settings from /etc/casambi-bt-webui.env, and the last change's result.", access: "admin", responses: { 200: { description: "The server settings.", schema: "ServerSettings" } } },
  { method: "put", path: "/admin/server-settings", tag: "Admin: bridge", summary: "Change the port or reverse-proxy setting", description: "Asks the Pi to write the settings to /etc/casambi-bt-webui.env and restart. If the app does not answer on the new port within a minute, the previous settings are restored. After a port change, open the app on the new port (and sign in again there).", access: "admin", body: "ServerSettingsUpdate", bodyRequired: true, responses: { 202: { description: "Requested.", schema: object({ requested: ref("ServerSettingsUpdate") }) }, 422: { description: "Not set up, invalid, or a change is still being applied.", schema: "Error" } } },
  { method: "get", path: "/admin/homekit", tag: "Admin: bridge", summary: "HomeKit bridge", description: "Settings, whether the bridge is published and announced, the setup code and QR code, and the number of pairings.", access: "admin", responses: { 200: { description: "The HomeKit status.", schema: "HomeKitStatus" } } },
  { method: "put", path: "/admin/homekit", tag: "Admin: bridge", summary: "Change the HomeKit bridge", description: "Turns the HomeKit bridge on or off, or changes its name or port, and republishes it. Pairings are kept.", access: "admin", body: "HomeKitSettings", bodyRequired: true, responses: { 200: { description: "Saved; the new status.", schema: "HomeKitStatus" }, 422: { description: "Invalid, or the port is the web app's port.", schema: "Error" } } },
  { method: "put", path: "/admin/homekit/accessories", tag: "Admin: bridge", summary: "Choose what HomeKit shows", description: "Hides the given lamps, groups, rooms, and scenes from HomeKit (removing them from Apple Home at once) and shows everything else.", access: "admin", body: "HomeKitAccessories", bodyRequired: true, responses: { 200: { description: "Saved; the new status.", schema: "HomeKitStatus" } } },
  { method: "post", path: "/admin/homekit/reset", tag: "Admin: bridge", summary: "Reset HomeKit pairing", description: "Removes every pairing and creates a new device id and setup code. Apple Home sees a new bridge: remove the old one there and add the bridge again.", access: "admin", responses: { 200: { description: "Reset; the new status.", schema: "HomeKitStatus" } } },
  { method: "get", path: "/admin/matter", tag: "Admin: bridge", summary: "Matter bridge (Google Home)", description: "Settings, whether the bridge runs and is paired, the connected ecosystems, and the setup code while the bridge can be added.", access: "admin", responses: { 200: { description: "The Matter status.", schema: "MatterStatus" } } },
  { method: "put", path: "/admin/matter", tag: "Admin: bridge", summary: "Change the Matter bridge", description: "Turns the Matter bridge on or off, or changes its name, port, vendor id, or product id, and restarts it. Pairings are kept.", access: "admin", body: "MatterSettings", bodyRequired: true, responses: { 200: { description: "Saved; the new status.", schema: "MatterStatus" }, 422: { description: "Invalid.", schema: "Error" } } },
  { method: "put", path: "/admin/matter/accessories", tag: "Admin: bridge", summary: "Choose what Google Home shows", description: "Hides the given lamps, groups, rooms, and scenes from Google Home (removing them there at once) and shows everything else. Separate from HomeKit's choice.", access: "admin", body: "MatterAccessories", bodyRequired: true, responses: { 200: { description: "Saved; the new status.", schema: "MatterStatus" } } },
  { method: "post", path: "/admin/matter/pairing-window", tag: "Admin: bridge", summary: "Let another ecosystem add the bridge", description: "Opens a 15-minute window in which another Matter controller can add the already paired bridge with the setup code.", access: "admin", responses: { 200: { description: "Opened; the new status with the setup code.", schema: "MatterStatus" }, 422: { description: "Not running or not paired yet.", schema: "Error" } } },
  { method: "delete", path: "/admin/matter/fabrics/{id}", tag: "Admin: bridge", summary: "Remove an ecosystem", description: "Removes one ecosystem's access (by fabric index from `fabrics`); the bridge disappears from that app.", access: "admin", responses: { 200: { description: "Removed; the new status.", schema: "MatterStatus" }, 404: { description: "No such connection.", schema: "Error" } } },
  { method: "post", path: "/admin/matter/reset", tag: "Admin: bridge", summary: "Reset the Matter bridge", description: "Removes every ecosystem and all Matter keys. The bridge can then be added again with the same setup code.", access: "admin", responses: { 200: { description: "Reset; the new status.", schema: "MatterStatus" } } },
  { method: "get", path: "/admin/update", tag: "Admin: bridge", summary: "Update status", description: "Whether updates from the app are set up (`supported`), the running version, open requests, and what deploy/update.sh last reported: `state` (checking, available, up_to_date, updating, updated, rolling_back, rolled_back, failed), the current and latest commit, the new changes, and for an update the tail of its log.", access: "admin", responses: { 200: { description: "The update status.", schema: "UpdateStatus" } } },
  { method: "post", path: "/admin/update/check", tag: "Admin: bridge", summary: "Check for an update", description: "Asks the Pi to fetch from the checkout's upstream branch and report how far it is behind. Runs in the background; poll `GET /admin/update`.", access: "admin", responses: { 202: { description: "Requested.", schema: object({ requested: { type: "string" } }) }, 422: { description: "Updates from the app are not set up.", schema: "Error" } } },
  { method: "post", path: "/admin/update/apply", tag: "Admin: bridge", summary: "Update now", description: "Asks the Pi to fast-forward to its upstream branch and run deploy/install.sh, which restarts the service. If the update fails, the previous version is installed again. Runs in the background; poll `GET /admin/update`.", access: "admin", responses: { 202: { description: "Requested.", schema: object({ requested: { type: "string" } }) }, 422: { description: "Not set up, or an update is already running.", schema: "Error" } } },
  { method: "get", path: "/admin/discovery", tag: "Admin: bridge", summary: "Scan for Casambi networks", description: "A 5-second Bluetooth scan; light commands wait while it runs. Strongest signal first.", access: "admin", responses: { 200: { description: "Networks in range.", schema: list("DiscoveredNetwork") } } },
  { method: "post", path: "/admin/connect", tag: "Admin: bridge", summary: "Connect", access: "admin", responses: { 200: { description: "Connected.", schema: "NetworkSnapshot" } } },
  { method: "post", path: "/admin/disconnect", tag: "Admin: bridge", summary: "Disconnect", access: "admin", responses: { 200: { description: "Disconnected.", schema: "NetworkSnapshot" } } },
  { method: "get", path: "/admin/worker", tag: "Admin: bridge", summary: "Bluetooth worker state", access: "admin", responses: { 200: { description: "Worker state.", schema: "WorkerState" } } },
  { method: "post", path: "/admin/worker/restart", tag: "Admin: bridge", summary: "Restart the Bluetooth worker", access: "admin", responses: { 202: { description: "Restart requested.", schema: "WorkerState" } } },
  // Administration: rooms, devices, away dates.
  { method: "post", path: "/admin/rooms/from-groups", tag: "Admin: rooms and devices", summary: "Create a room for each Casambi group", description: "Creates a room named after each Casambi group (reusing a room with the same name) and places the group's units in it. A unit in several groups goes to the first; units already in a room stay. Room commands then go out as one group command.", access: "admin", responses: { 201: { description: "Rooms created and units placed.", schema: object({ created: { type: "integer" }, assigned: { type: "integer" }, rooms: list("Room") }) }, 422: { description: "The connected network has no groups.", schema: "Error" } } },
  { method: "post", path: "/admin/rooms", tag: "Admin: rooms and devices", summary: "Create a room", access: "admin", body: "RoomCreate", bodyRequired: true, responses: { 201: { description: "Room created.", schema: "Room" }, 409: { description: "The name is already in use.", schema: "Error" } } },
  { method: "put", path: "/admin/rooms/{id}/default-brightness", tag: "Admin: rooms and devices", summary: "Set a room's default brightness", access: "admin", body: "RoomDefaultBrightness", bodyRequired: true, responses: { 200: { description: "Updated.", schema: "Room" } } },
  { method: "patch", path: "/admin/rooms/{id}", tag: "Admin: rooms and devices", summary: "Rename a room", access: "admin", body: "RoomRename", bodyRequired: true, responses: { 200: { description: "Renamed.", schema: "Room" }, 409: { description: "The name is already in use.", schema: "Error" } } },
  { method: "delete", path: "/admin/rooms/{id}", tag: "Admin: rooms and devices", summary: "Delete a room", description: "Refused while timers, switch rules, or scenes use it.", access: "admin", responses: { 204: noContent, 409: { description: "Still in use; the message names the users.", schema: "Error" } } },
  { method: "put", path: "/admin/devices/room", tag: "Admin: rooms and devices", summary: "Assign many units to a room", description: "Moves up to 1,000 units into one room, or out of every room with `roomId: null`, in one request. Custom names are kept.", access: "admin", body: "DeviceRooms", bodyRequired: true, responses: { 204: noContent, 422: { description: "Invalid input, or the room does not exist.", schema: "Error" } } },
  { method: "put", path: "/admin/devices/{id}/metadata", tag: "Admin: rooms and devices", summary: "Name a unit and assign its room", description: "Fields left out keep their value; an empty or null name restores the name from Casambi.", access: "admin", body: "DeviceMetadata", bodyRequired: true, responses: { 204: noContent } },
  { method: "get", path: "/admin/away-date-sets", tag: "Admin: rooms and devices", summary: "Away-date sets", access: "admin", responses: { 200: { description: "Sets.", schema: list("AwayDateSet") } } },
  { method: "post", path: "/admin/away-date-sets", tag: "Admin: rooms and devices", summary: "Create an away-date set", access: "admin", body: "AwayDateSetCreate", bodyRequired: true, responses: { 201: { description: "Created.", schema: "AwayDateSet" } } },
  { method: "patch", path: "/admin/away-date-sets/{id}", tag: "Admin: rooms and devices", summary: "Update an away-date set", access: "admin", body: "AwayDateSetUpdate", bodyRequired: true, responses: { 200: { description: "Updated.", schema: "AwayDateSet" } } },
  { method: "delete", path: "/admin/away-date-sets/{id}", tag: "Admin: rooms and devices", summary: "Delete an away-date set", description: "Detaches it from its timers.", access: "admin", responses: { 204: noContent } },
  // Administration: accounts and keys.
  { method: "get", path: "/admin/users", tag: "Admin: accounts", summary: "Accounts", access: "admin", responses: { 200: { description: "Accounts.", schema: list("User") } } },
  { method: "post", path: "/admin/users", tag: "Admin: accounts", summary: "Create an account", access: "admin", body: "UserCreate", bodyRequired: true, responses: { 201: { description: "Created.", schema: "User" }, 409: { description: "The username is already in use.", schema: "Error" } } },
  { method: "patch", path: "/admin/users/{id}", tag: "Admin: accounts", summary: "Change an account's role or reset its password", description: "Takes effect immediately; at least one admin must remain.", access: "admin", body: "UserUpdate", bodyRequired: true, responses: { 200: { description: "Updated.", schema: "User" } } },
  { method: "delete", path: "/admin/users/{id}", tag: "Admin: accounts", summary: "Delete an account", description: "Its timers move to the admin who deletes it. You cannot delete your own account or the last admin.", access: "admin", responses: { 204: noContent } },
  { method: "get", path: "/admin/api-keys", tag: "Admin: accounts", summary: "API keys", access: "admin", responses: { 200: { description: "Keys (without the secret).", schema: list("ApiKey") } } },
  { method: "post", path: "/admin/api-keys", tag: "Admin: accounts", summary: "Create an API key", access: "admin", body: "ApiKeyCreate", bodyRequired: true, responses: { 201: { description: "Created; the token is shown only now.", schema: "ApiKeyCreated" } } },
  { method: "delete", path: "/admin/api-keys/{id}", tag: "Admin: accounts", summary: "Revoke an API key", access: "admin", responses: { 204: noContent } },
  { method: "get", path: "/admin/audit", tag: "Admin: accounts", summary: "Recent audit entries", description: "Newest first. The log keeps the latest 20,000 entries.", access: "admin", query: [{ name: "limit", description: "1-500, default 100.", schema: { type: "integer", minimum: 1, maximum: 500 } }, { name: "action", description: "Action prefix, e.g. `bridge.` or `schedule.`.", schema: { type: "string" } }], responses: { 200: { description: "Entries.", schema: list("AuditEntry") } } },
  // Administration: switches.
  { method: "get", path: "/admin/switch-activity", tag: "Admin: switches", summary: "Recent switch presses", access: "admin", responses: { 200: { description: "Newest first.", schema: list("SwitchPress") } } },
  { method: "get", path: "/admin/switch-rules", tag: "Admin: switches", summary: "Switch rules", access: "admin", responses: { 200: { description: "Rules.", schema: list("SwitchRule") } } },
  { method: "post", path: "/admin/switch-rules", tag: "Admin: switches", summary: "Create a switch rule", access: "admin", body: "SwitchRuleCreate", bodyRequired: true, responses: { 201: { description: "Created.", schema: "SwitchRule" } } },
  { method: "patch", path: "/admin/switch-rules/{id}", tag: "Admin: switches", summary: "Update a switch rule", description: "Only the fields sent are changed.", access: "admin", body: "SwitchRuleUpdate", bodyRequired: true, responses: { 200: { description: "Updated.", schema: "SwitchRule" } } },
  { method: "delete", path: "/admin/switch-rules/{id}", tag: "Admin: switches", summary: "Delete a switch rule", access: "admin", responses: { 204: noContent } },
];

const errorResponse = (description: string) => ({ description, content: { "application/json": { schema: ref("Error") } } });

function buildOperation(operation: Operation): JsonSchema {
  const responses: Record<string, unknown> = {};
  for (const [status, response] of Object.entries(operation.responses)) {
    const schema = typeof response.schema === "string" ? ref(response.schema) : response.schema;
    responses[status] = schema ? { description: response.description, content: { [response.contentType ?? "application/json"]: { schema } } } : { description: response.description };
  }
  const hasId = operation.path.includes("{id}");
  if (operation.access !== "public") responses[401] ??= errorResponse("Missing or invalid JWT or API key.");
  if (operation.access === "admin") responses[403] ??= errorResponse("The admin role is required.");
  if (hasId) responses[404] ??= errorResponse("No item with this id.");
  if (operation.body || hasId) responses[422] ??= errorResponse("The request is invalid; see `error.fields`.");
  responses[429] ??= errorResponse("Too many requests (240 per minute per client).");
  responses[500] ??= errorResponse("Unexpected server error.");
  return {
    tags: [operation.tag],
    summary: operation.summary,
    ...(operation.description ? { description: operation.description } : {}),
    operationId: `${operation.method}${operation.path.replace(/\{(\w+)\}/g, "By_$1").replace(/[^a-zA-Z0-9]+(.)?/g, (_match, next: string | undefined) => next ? next.toUpperCase() : "")}`,
    "x-required-role": operation.access,
    security: operation.access === "public" ? [] : [{ bearerAuth: [] }, { apiKey: [] }],
    parameters: [
      ...(hasId ? [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }] : []),
      ...(operation.query ?? []).map(parameter => ({ ...parameter, in: "query", required: false })),
      ...(operation.headers ?? []).map(header => ({ ...header, in: "header", schema: { type: "string" } })),
    ],
    ...(operation.body ? { requestBody: { required: operation.bodyRequired ?? false, content: { [operation.bodyContentType ?? "application/json"]: { schema: ref(operation.body) } } } } : {}),
    responses,
  };
}

/** Every documented operation as "METHOD /path" (OpenAPI path syntax), for the route-parity test. */
export const documentedOperations = operations.map(operation => `${operation.method.toUpperCase()} ${operation.path}`);

const tagDescriptions: Record<string, string> = {
  System: "Health, this document, and the live event stream.",
  Authentication: "Sign in for a JWT, or create the first admin.",
  Network: "Read units, groups, Casambi scenes, rooms, and sensors.",
  Control: "Switch and dim lamps, groups, rooms, the network, and scenes.",
  Scenes: "Scenes saved on the Pi: the captured setting of a group, room, or all lights.",
  Timers: "Time and sunrise/sunset timers with away dates.",
  "Admin: bridge": "Casambi connection settings, discovery, and the Bluetooth worker.",
  "Admin: rooms and devices": "Rooms, unit names, and shared away-date sets.",
  "Admin: accounts": "Accounts, API keys, and the audit log.",
  "Admin: switches": "Physical switch activity and the rules that react to it.",
};

let document: JsonSchema | null = null;

/** The OpenAPI 3.1 description of `/api/v1`, served at `/api/v1/openapi.json`. */
export function openApiDocument(): JsonSchema {
  if (document) return document;
  const paths: Record<string, Record<string, JsonSchema>> = {};
  for (const operation of operations) (paths[operation.path] ??= {})[operation.method] = buildOperation(operation);
  document = {
    openapi: "3.1.0",
    info: {
      title: "Casambi BT WebGUI REST API",
      version: "1.0.0",
      description: "Local REST API of the Casambi BT WebGUI on the Raspberry Pi. Authenticate with a JWT from `POST /auth/login` (Authorization: Bearer) or an API key created by an admin (X-API-Key). Brightness levels are 0-255.",
    },
    servers: [{ url: "/api/v1" }],
    security: [{ bearerAuth: [] }, { apiKey: [] }],
    tags: Array.from(new Set(operations.map(operation => operation.tag))).map(name => ({ name, description: tagDescriptions[name] })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "From POST /auth/login; valid for 8 hours." },
        apiKey: { type: "apiKey", in: "header", name: "X-API-Key", description: "Created by an admin; scoped to the admin or user role." },
      },
      schemas,
    },
  };
  return document;
}

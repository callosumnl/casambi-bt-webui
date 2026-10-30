import { z } from "zod";

/** A fixture control reported by the Casambi library. */
export const capabilitySchema = z.object({
  type: z.string(),
  min: z.number().nullable().optional(),
  max: z.number().nullable().optional(),
  readOnly: z.boolean().default(false),
});

/** A normalized live state for a Casambi unit. Values use upstream units. */
export const unitStateSchema = z.object({
  dimmer: z.number().int().min(0).max(255).nullable().optional(),
  temperature: z.number().int().nullable().optional(),
  rgb: z.tuple([z.number().int(), z.number().int(), z.number().int()]).nullable().optional(),
  white: z.number().int().min(0).max(255).nullable().optional(),
  vertical: z.number().int().min(0).max(255).nullable().optional(),
  slider: z.number().int().min(0).max(255).nullable().optional(),
  xy: z.tuple([z.number(), z.number()]).nullable().optional(),
  /** Which colour a unit with several colour controls shows. */
  colorSource: z.enum(["temperature", "rgb", "xy"]).nullable().optional(),
  sensors: z.array(z.object({ label: z.string(), value: z.number().nullable(), unit: z.string().nullable() })).default([]),
  on: z.boolean(),
  online: z.boolean(),
});

export const unitSchema = z.object({
  id: z.number().int(),
  uuid: z.string(),
  address: z.string(),
  name: z.string(),
  firmwareVersion: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  manufacturer: z.string().nullable().optional(),
  capabilities: z.array(capabilitySchema),
  state: unitStateSchema,
});

export const groupSchema = z.object({ id: z.number().int(), name: z.string(), unitIds: z.array(z.number().int()) });
export const sceneSchema = z.object({ id: z.number().int(), name: z.string() });

/** Full snapshot communicated by the Python bridge. */
export const networkSnapshotSchema = z.object({
  connected: z.boolean(),
  network: z.object({ id: z.string(), name: z.string() }).nullable(),
  units: z.array(unitSchema),
  groups: z.array(groupSchema),
  scenes: z.array(sceneSchema),
  updatedAt: z.string(),
});

export type Capability = z.infer<typeof capabilitySchema>;
export type UnitState = z.infer<typeof unitStateSchema>;
export type UnitSnapshot = z.infer<typeof unitSchema>;
export type GroupSnapshot = z.infer<typeof groupSchema>;
export type SceneSnapshot = z.infer<typeof sceneSchema>;
export type NetworkSnapshot = z.infer<typeof networkSnapshotSchema>;

/** `scene` is a scene stored in the Casambi network; `local_scene` is a scene saved on the Pi (see LocalStore light scenes). */
export const targetTypeSchema = z.enum(["unit", "group", "room", "scene", "local_scene", "network"]);
export const operationSchema = z.enum([
  "on",
  "off",
  "set_level",
  "set_temperature",
  "set_color",
  "set_white",
  "set_vertical",
  "set_slider",
  "set_xy",
  "activate_scene",
  "wake_up",
]);

/**
 * A wake-up light: lamps start at the lowest level in warm white and rise to `level` while the colour temperature
 * moves to cool white, over `minutes`. Lamps without colour temperature only rise in brightness.
 */
export const wakeUpSchema = z.object({
  minutes: z.number().int().min(5).max(60),
  level: z.number().int().min(1).max(255),
  warmKelvin: z.number().int().min(1800).max(6500).default(2200),
  coolKelvin: z.number().int().min(1800).max(6500).default(4000),
});
export type WakeUp = z.infer<typeof wakeUpSchema>;

/** Validated command sent from REST, schedules, or the UI to Casambi. */
export const controlRequestSchema = z.object({
  targetType: targetTypeSchema,
  targetId: z.union([z.number().int().nonnegative(), z.string().min(1)]).nullable().optional(),
  operation: operationSchema,
  value: z.unknown().optional(),
  fadeDurationMs: z.number().int().min(0).max(60_000).optional(),
}).superRefine((value, ctx) => {
  const numberOps = ["set_level", "set_temperature", "set_white", "set_vertical", "set_slider"];
  if (numberOps.includes(value.operation) && (typeof value.value !== "number" || !Number.isFinite(value.value))) {
    ctx.addIssue({ code: "custom", message: "A numeric value is required for this operation.", path: ["value"] });
  }
  // Upstream raises a bare ValueError (or OverflowError for temperatures) outside these ranges.
  const byteOps = ["set_level", "set_white", "set_vertical", "set_slider"];
  if (byteOps.includes(value.operation) && typeof value.value === "number" && (value.value < 0 || value.value > 255)) {
    ctx.addIssue({ code: "custom", message: "The value must be from 0 to 255.", path: ["value"] });
  }
  if (value.operation === "set_temperature" && typeof value.value === "number" && (value.value < 1000 || value.value > 12000)) {
    ctx.addIssue({ code: "custom", message: "The colour temperature must be from 1000 to 12000 K.", path: ["value"] });
  }
  if (value.operation === "activate_scene" && value.value !== undefined && (typeof value.value !== "number" || !Number.isInteger(value.value) || value.value < 0 || value.value > 255)) {
    ctx.addIssue({ code: "custom", message: "A scene level must be an integer from 0 to 255.", path: ["value"] });
  }
  if (value.operation === "set_color" && (!Array.isArray(value.value) || value.value.length !== 3 || !value.value.every(item => Number.isInteger(item) && item >= 0 && item <= 255))) {
    ctx.addIssue({ code: "custom", message: "RGB colour must be an array of three integers from 0 to 255.", path: ["value"] });
  }
  if (value.operation === "set_xy" && (!Array.isArray(value.value) || value.value.length !== 2 || !value.value.every(item => typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 1))) {
    ctx.addIssue({ code: "custom", message: "XY colour must be an array of two numbers from 0 to 1.", path: ["value"] });
  }
  if (value.operation === "wake_up") {
    const parsed = wakeUpSchema.safeParse(value.value);
    if (!parsed.success) ctx.addIssue({ code: "custom", message: "A wake-up light needs minutes (5–60), a level (1–255), and colour temperatures from 1800 to 6500 K.", path: ["value"] });
    if (value.fadeDurationMs) ctx.addIssue({ code: "custom", message: "A wake-up light has its own duration; fadeDurationMs cannot be used with it.", path: ["fadeDurationMs"] });
  }
  if (value.targetType !== "network" && (value.targetId === undefined || value.targetId === null)) {
    ctx.addIssue({ code: "custom", message: "A targetId is required for this target type.", path: ["targetId"] });
  }
  // On a non-scene target upstream turns "activate scene" into "set every light to full".
  if (value.operation === "activate_scene" && value.targetType !== "scene" && value.targetType !== "local_scene") {
    ctx.addIssue({ code: "custom", message: "Only scenes can be activated.", path: ["targetType"] });
  }
  if ((value.targetType === "scene" || value.targetType === "local_scene") && value.operation !== "activate_scene") {
    ctx.addIssue({ code: "custom", message: "Scenes can only be activated.", path: ["operation"] });
  }
});

export type ControlRequest = z.infer<typeof controlRequestSchema>;

/** Capabilities that make a unit a controllable light. Switches and sensors report none of these. */
export const LAMP_CAPABILITIES = new Set(["dimmer", "onoff", "white", "rgb", "temperature", "vertical", "colorsource", "xy", "slider"]);
export function isLampUnit(unit: Pick<UnitSnapshot, "capabilities">): boolean { return unit.capabilities.some(capability => LAMP_CAPABILITIES.has(capability.type)); }

/** Button triggers a switch rule can react to, derived from upstream's reliable type 0x10 switch messages. */
export const switchTriggerSchema = z.enum(["tap", "hold", "release_after_hold"]);
export type SwitchTrigger = z.infer<typeof switchTriggerSchema>;
/** One reported button message. `trigger` is null for raw activity that must not drive automations. */
export type SwitchPress = { unitId: number | null; button: number | null; trigger: SwitchTrigger | null; raw: Record<string, unknown> };

export type BridgeEvent =
  | { type: "bridge"; state: "starting" | "connected" | "disconnected" | "unavailable"; detail?: string }
  | { type: "unit.state"; unit: UnitSnapshot }
  | { type: "switch"; press: SwitchPress };

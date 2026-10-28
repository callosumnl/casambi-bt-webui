import { z } from "zod";
import { controlRequestSchema } from "./casambi/types";

/**
 * Request schemas for the REST API. `api.ts` validates every request with them and `openapi.ts` turns
 * them into the published OpenAPI document, so the two can never disagree.
 */
export const roleSchema = z.enum(["admin", "user"]);
export const credentialsSchema = z.object({ username: z.string().trim().min(3).max(64).regex(/^[a-z0-9._-]+$/i), password: z.string().min(12).max(256) });
export const bootstrapSchema = credentialsSchema.extend({ setupCode: z.string().trim().max(64).optional() });
export const configSchema = z.object({ networkAddress: z.string().trim().min(1).max(128).nullable().optional(), networkUuid: z.string().trim().max(128).nullable().optional(), apiKey: z.string().max(512).nullable().optional(), networkPassword: z.string().max(512).nullable().optional(), btAdapter: z.string().trim().max(128).nullable().optional(), forceOffline: z.boolean().optional(), fastWrites: z.boolean().optional().describe("Experimental: send commands as Bluetooth writes without response. Applied without reconnecting."), pollingEnabled: z.boolean().optional(), pollingIntervalSeconds: z.number().int().min(5).max(3600).optional(), solarLatitude: z.number().min(-90).max(90).nullable().optional(), solarLongitude: z.number().min(-180).max(180).nullable().optional() });
export const solarSchema = z.object({ event: z.enum(["sunrise", "sunset"]), offsetMinutes: z.number().int().min(-180).max(180) });
export const sceneScopeSchema = z.object({ type: z.enum(["group", "room", "network"]), id: z.number().int().nonnegative().nullable() })
  .refine(scope => (scope.type === "network") === (scope.id === null), { message: "A group or room scope requires an id; the network scope has none." });
export const sceneNameSchema = z.string().trim().min(1).max(64);
export const holidayDatesSchema = z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(120);
export const awayDateSetSchema = z.object({ name: z.string().trim().min(1).max(96), dates: holidayDatesSchema.min(1) });
export const scheduleSchema = z.object({ name: z.string().trim().min(1).max(96), cronExpression: z.string().trim().min(9).max(128).optional(), timezone: z.string().trim().min(1).max(80), command: controlRequestSchema, solar: solarSchema.nullable().optional(), holidayDates: holidayDatesSchema.default([]), awayDateSetId: z.number().int().positive().nullable().optional(), enabled: z.boolean().default(true) });
/** For PATCH: only the fields sent are changed (no defaults, unlike scheduleSchema.partial()). */
export const schedulePatchSchema = z.object({ name: z.string().trim().min(1).max(96), cronExpression: z.string().trim().min(9).max(128).optional(), timezone: z.string().trim().min(1).max(80), command: controlRequestSchema, solar: solarSchema.nullable().optional(), holidayDates: holidayDatesSchema, awayDateSetId: z.number().int().positive().nullable().optional(), enabled: z.boolean() }).partial();
export const fadeBodySchema = z.object({ fadeDurationMs: z.number().int().min(0).max(60_000).optional() });
export const sceneCreateSchema = z.object({ name: sceneNameSchema, scope: sceneScopeSchema });
export const sceneRenameSchema = z.object({ name: sceneNameSchema });
export const roomCreateSchema = z.object({ name: z.string().trim().min(1).max(96), defaultBrightnessPercent: z.number().int().min(0).max(100).default(100) });
export const roomDefaultBrightnessSchema = z.object({ defaultBrightnessPercent: z.number().int().min(0).max(100) });
/** Either field may be left out to keep its current value; an empty or null name restores the Casambi name. */
export const deviceMetadataSchema = z.object({ customName: z.string().trim().max(128).nullable().optional(), roomId: z.number().int().positive().nullable().optional() });
export const deviceRoomsSchema = z.object({ unitIds: z.array(z.number().int().positive()).min(1).max(1000), roomId: z.number().int().positive().nullable() });
export const userCreateSchema = credentialsSchema.extend({ role: roleSchema });
export const userUpdateSchema = z.object({ role: roleSchema.optional(), password: credentialsSchema.shape.password.optional() })
  .refine(update => update.role !== undefined || update.password !== undefined, { message: "Send a new role, a new password, or both." });
export const roomRenameSchema = z.object({ name: z.string().trim().min(1).max(96) });
export const auditQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), action: z.string().trim().min(1).max(64).optional() });
export const apiKeyCreateSchema = z.object({ label: z.string().trim().min(1).max(96), role: roleSchema, expiresInDays: z.number().int().min(1).max(3650).optional().describe("Days until the key stops working; omit for a key that never expires.") });
export const backupCreateSchema = z.object({ passphrase: z.string().min(10).max(256).describe("Protects the backup; needed to restore it. At least 10 characters.") });

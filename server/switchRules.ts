import { z } from "zod";
import { EventHub } from "./events";
import { LocalStore, SwitchRuleCommand, SwitchRuleRecord, UnitMetadata } from "./store";
import type { CasambiService, TimedSwitchPress } from "./casambi/service";
import { controlRequestSchema, switchTriggerSchema, type ControlRequest, type NetworkSnapshot } from "./casambi/types";

const toggleCommandSchema = z.object({
  targetType: z.enum(["unit", "group", "room", "network"]),
  targetId: z.union([z.number().int().nonnegative(), z.string().min(1)]).nullable().optional(),
  operation: z.literal("toggle"),
});
/** A rule action: a toggle, or any command the REST control endpoint accepts. */
export const switchRuleCommandSchema = z.union([toggleCommandSchema, controlRequestSchema]);
export const switchRuleSchema = z.object({
  name: z.string().trim().min(1).max(96),
  unitId: z.number().int().nonnegative(),
  button: z.number().int().nonnegative(),
  trigger: switchTriggerSchema,
  command: switchRuleCommandSchema,
  enabled: z.boolean().default(true),
});

/** Resolves a toggle to "off" when any targeted lamp is on, otherwise "on". Other commands pass through unchanged. */
export function resolveSwitchCommand(command: SwitchRuleCommand, snapshot: NetworkSnapshot, unitMetadata: UnitMetadata[]): ControlRequest {
  if (command.operation !== "toggle") return command;
  const id = Number(command.targetId);
  const unitIds = new Set(
    command.targetType === "unit" ? [id]
      : command.targetType === "group" ? snapshot.groups.find(group => group.id === id)?.unitIds ?? []
        : command.targetType === "room" ? unitMetadata.filter(metadata => metadata.roomId === id).map(metadata => metadata.unitId)
          : snapshot.units.map(unit => unit.id),
  );
  const anyOn = snapshot.units.some(unit => unitIds.has(unit.id) && unit.state.on);
  return { targetType: command.targetType, targetId: command.targetId ?? null, operation: anyOn ? "off" : "on" };
}

type RuleService = Pick<CasambiService, "control" | "cachedSnapshot">;

/**
 * Runs enabled switch rules for each trigger press through the same control path as the API.
 * Presses are handled one at a time so a toggle sees the state left by the previous press.
 */
export class SwitchRuleRunner {
  private chain: Promise<void> = Promise.resolve();

  public constructor(private readonly store: LocalStore, private readonly service: RuleService, private readonly events: EventHub) {}

  public handle(press: TimedSwitchPress): Promise<void> {
    if (!press.trigger) return this.chain;
    this.chain = this.chain.then(() => this.run(press));
    return this.chain;
  }

  private async run(press: TimedSwitchPress): Promise<void> {
    const rules = this.store.listSwitchRules().filter(rule => rule.enabled && rule.unitId === press.unitId && rule.button === press.button && rule.trigger === press.trigger);
    for (const rule of rules) await this.execute(rule);
  }

  private async execute(rule: SwitchRuleRecord): Promise<void> {
    try {
      const command = resolveSwitchCommand(rule.command, this.service.cachedSnapshot(), this.store.getUnitMetadata());
      await this.service.control(command, `switch-rule:${rule.id}`);
      this.store.markSwitchRuleTriggered(rule.id);
      this.store.audit("switch", "switch_rule.executed", { ruleId: rule.id, operation: command.operation });
      this.events.publish("switch_rule.executed", { ruleId: rule.id, operation: command.operation });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error.";
      this.store.audit("switch", "switch_rule.failed", { ruleId: rule.id, message });
      this.events.publish("switch_rule.failed", { ruleId: rule.id, message });
    }
  }
}

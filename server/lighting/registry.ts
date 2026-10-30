import type { ControlRequest, SwitchPress, UnitSnapshot } from "../casambi/types";
import type { LocalStore } from "../store";
import { describeLights, LightDescriptor, LightingSnapshot, lightUnitIds, NameRule, plainName, switchKey } from "./model";

/** Where a smart home bridge reads state and sends commands; CasambiService in the app. */
export interface LightingSource {
  cachedSnapshot(): LightingSnapshot;
  control(command: ControlRequest, actor: string): Promise<unknown>;
  onStateChange(listener: () => void): void;
  /** Wall switch presses; optional, so a source without switches works too. */
  onSwitchPress?(listener: (press: SwitchPress) => void): void;
}

/** One entry in the Admin panel's list of what a platform can show. */
export type CatalogEntry = { key: string; kind: LightDescriptor["kind"]; name: string; shown: boolean };

/** What one sync or settings change did to the list; the platform adds, removes, rebuilds, or renames its devices. */
export type RegistryChange = { added: LightDescriptor[]; removed: LightDescriptor[]; rebuilt: LightDescriptor[]; renamed: LightDescriptor[] };
const noChange = (): RegistryChange => ({ added: [], removed: [], rebuilt: [], renamed: [] });

export type RegistryOptions = {
  /** Settings key prefix ("homekit", "matter"): each platform keeps its own list, hidden keys, and learned buttons. */
  prefix: string;
  nameOf?: NameRule;
  /** How long a lamp, group, or Casambi scene may be missing from a connected network before it is removed. */
  removeAfterMs: number;
  now: () => number;
};

/**
 * The lamps, groups, rooms, scenes, and wall switches a smart home platform shows, independent of its protocol. The
 * list is kept in the settings table, so after a restart, or while the network is disconnected, the platform still
 * finds every device instead of deleting it together with its room and automations. An administrator can hide any
 * of them; wall switch buttons are learned from presses, because Casambi does not report how many a switch has.
 */
export class LightRegistry {
  private readonly shown = new Map<string, { descriptor: LightDescriptor; missingSince: number | null }>();
  /** Everything the platform could show, hidden or not, as last seen on a connected network. */
  private readonly known = new Map<string, LightDescriptor>();
  private hidden = new Set<string>();
  private buttons: Record<string, number[]> = {};

  public constructor(private readonly store: LocalStore, private readonly options: RegistryOptions) {
    this.reload();
  }

  /** Reads the list, hidden keys, and learned buttons again, for example after a restore replaced the database. */
  public reload(): void {
    this.shown.clear();
    this.known.clear();
    for (const descriptor of this.loadCache()) { this.shown.set(descriptor.key, { descriptor, missingSince: null }); this.known.set(descriptor.key, descriptor); }
    this.hidden = new Set(this.loadHidden());
    this.buttons = this.loadButtons();
  }

  /** What the platform shows now. */
  public entries(): LightDescriptor[] { return Array.from(this.shown.values(), entry => entry.descriptor); }
  public get(key: string): LightDescriptor | undefined { return this.shown.get(key)?.descriptor; }

  /** Everything the platform can show, and whether it does; for the Admin panel. */
  public catalog(): CatalogEntry[] {
    return Array.from(this.known.values(), descriptor => ({ key: descriptor.key, kind: descriptor.kind, name: descriptor.name, shown: !this.hidden.has(descriptor.key) }));
  }

  /** Brings the list in line with a connected network: new, changed, renamed, and removed lamps, groups, rooms, scenes, and switches. */
  public reconcile(snapshot: LightingSnapshot): RegistryChange {
    const change = noChange();
    const now = this.options.now();
    const localScenes = this.store.listLightScenes();
    const all = describeLights(snapshot, localScenes, this.buttons, this.options.nameOf ?? plainName);
    this.known.clear();
    for (const descriptor of all) this.known.set(descriptor.key, descriptor);
    const fresh = new Map(all.filter(descriptor => !this.hidden.has(descriptor.key)).map(descriptor => [descriptor.key, descriptor]));
    const roomIds = new Set(snapshot.rooms.map(room => room.id));
    const localSceneIds = new Set(localScenes.map(scene => scene.id));
    const features = (item: LightDescriptor) => JSON.stringify([item.id, item.dimmable, item.temperature, item.color, item.buttons ?? null]);
    for (const descriptor of Array.from(fresh.values())) {
      const entry = this.shown.get(descriptor.key);
      if (!entry) {
        this.shown.set(descriptor.key, { descriptor, missingSince: null });
        change.added.push(descriptor);
        continue;
      }
      entry.missingSince = null;
      // A changed set of features needs a new device; the platform keeps it in place because its key stays.
      if (features(entry.descriptor) !== features(descriptor)) { entry.descriptor = descriptor; change.rebuilt.push(descriptor); }
      else if (entry.descriptor.name !== descriptor.name) { entry.descriptor = descriptor; change.renamed.push(descriptor); }
    }
    for (const [key, entry] of Array.from(this.shown.entries())) {
      if (fresh.has(key)) continue;
      // Hidden, a deleted room or saved scene, or a room left out as a duplicate (its lamps are known): gone for sure.
      // A lamp, group, or Casambi scene may only be missing from one incomplete snapshot.
      const { kind, id } = entry.descriptor;
      const gone = this.hidden.has(key)
        || (kind === "room" && (!roomIds.has(id) || lightUnitIds(entry.descriptor, snapshot).length > 0))
        || (kind === "local_scene" && !localSceneIds.has(id));
      entry.missingSince ??= now;
      if (!gone && now - entry.missingSince < this.options.removeAfterMs) continue;
      this.shown.delete(key);
      change.removed.push(entry.descriptor);
    }
    if (change.added.length || change.removed.length || change.rebuilt.length || change.renamed.length) this.saveCache();
    return change;
  }

  /** Hides these keys and shows everything else known; hidden devices are removed at once. */
  public setHidden(keys: string[]): RegistryChange {
    const change = noChange();
    this.hidden = new Set(keys);
    this.store.setAppSetting(`${this.options.prefix}.hidden`, JSON.stringify(Array.from(this.hidden)));
    for (const [key, entry] of Array.from(this.shown.entries())) {
      if (!this.hidden.has(key)) continue;
      this.shown.delete(key);
      change.removed.push(entry.descriptor);
    }
    // Shown again: known from an earlier connected sync, so it can come back while the network is disconnected too.
    for (const descriptor of Array.from(this.known.values())) {
      if (this.hidden.has(descriptor.key) || this.shown.has(descriptor.key)) continue;
      this.shown.set(descriptor.key, { descriptor, missingSince: null });
      change.added.push(descriptor);
    }
    this.saveCache();
    return change;
  }

  /**
   * Learns a wall switch button from a press. Returns true when the button was new (the switch appears or gets it at
   * the next reconcile); false when it was known already, so the press is an event the platform passes on.
   */
  public learnButton(unit: Pick<UnitSnapshot, "id" | "uuid">, button: number): boolean {
    const id = switchKey(unit);
    const known = this.buttons[id] ?? [];
    if (known.includes(button)) return false;
    this.buttons = { ...this.buttons, [id]: [...known, button] };
    this.store.setAppSetting(`${this.options.prefix}.buttons`, JSON.stringify(this.buttons));
    this.store.audit(this.options.prefix, `${this.options.prefix}.button_learned`, { unitId: unit.id, button });
    return true;
  }

  private loadCache(): LightDescriptor[] {
    try {
      const cached = JSON.parse(this.store.appSetting(`${this.options.prefix}.lights`) || "[]") as unknown;
      if (!Array.isArray(cached)) return [];
      // Lights cached before colour support have no colour fields; they get them at the next connected sync.
      return cached.filter(item => Boolean(item) && typeof item.key === "string" && typeof item.name === "string" && ["unit", "group", "room", "scene", "local_scene", "switch"].includes(item.kind) && typeof item.id === "number" && typeof item.dimmable === "boolean")
        .map(item => ({ ...item, temperature: item.temperature ?? null, color: item.color === true }) as LightDescriptor);
    } catch { return []; }
  }

  private loadButtons(): Record<string, number[]> {
    try {
      const stored = JSON.parse(this.store.appSetting(`${this.options.prefix}.buttons`) || "{}") as unknown;
      if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
      return Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, Array.isArray(value) ? value.filter((button): button is number => Number.isInteger(button)) : []]));
    } catch { return {}; }
  }

  private loadHidden(): string[] {
    try {
      const hidden = JSON.parse(this.store.appSetting(`${this.options.prefix}.hidden`) || "[]") as unknown;
      return Array.isArray(hidden) ? hidden.filter((key): key is string => typeof key === "string") : [];
    } catch { return []; }
  }

  private saveCache(): void {
    this.store.setAppSetting(`${this.options.prefix}.lights`, JSON.stringify(this.entries()));
  }
}

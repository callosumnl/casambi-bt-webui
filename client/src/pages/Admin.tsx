import { Cable, Home, Lightbulb, MousePointerClick, Rocket, Server, ShieldCheck, Speaker, Stethoscope, Users } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { Link, useParams } from "wouter";
import { AccountsPanel } from "@/components/AccountsPanel";
import { ApiKeysPanel } from "@/components/ApiKeysPanel";
import { AuditLogPanel } from "@/components/AuditLogPanel";
import { AwayDateSetsPanel } from "@/components/AwayDateSetsPanel";
import { BackupPanel } from "@/components/BackupPanel";
import { CasambiLinkPanel } from "@/components/CasambiLinkPanel";
import { DeviceMetadataPanel } from "@/components/DeviceMetadataPanel";
import { AccessoriesPanel } from "@/components/AccessoriesPanel";
import { HomeKitPanel } from "@/components/HomeKitPanel";
import { HudFrame } from "@/components/HudFrame";
import { MatterPanel } from "@/components/MatterPanel";
import { NotificationsPanel } from "@/components/NotificationsPanel";
import { RoomsPanel } from "@/components/RoomsPanel";
import { ServerSettingsPanel } from "@/components/ServerSettingsPanel";
import { SolarLocationPanel } from "@/components/SolarLocationPanel";
import { SwitchRulesPanel } from "@/components/SwitchRulesPanel";
import { UpdatePanel } from "@/components/UpdatePanel";
import { useNetwork } from "@/hooks/useNetwork";
import { ADMIN_SECTIONS, adminSection, adminSectionLabel, adminSectionSummary, type AdminSection } from "@/lib/adminSections";
import { t } from "@/lib/i18n";
import { LocalApi } from "@/lib/localApi";

const SECTION_ICONS: Record<AdminSection, typeof Cable> = { connection: Cable, rooms: Lightbulb, automation: MousePointerClick, access: Users, homekit: Home, google: Speaker, system: Server };

/** Admin-only configuration, split into sections so each page shows one subject. */
export default function Admin() {
  const api = useMemo(() => new LocalApi(), []);
  const { network, connection, refresh } = useNetwork();
  const section = adminSection(useParams<{ section?: string }>().section);
  const notify = (message: string) => { toast(message); };
  // On a phone the tabs scroll sideways; keep the open one in view.
  const tabs = useRef<HTMLElement>(null);
  useEffect(() => { tabs.current?.querySelector(".admin-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [section]);
  return <div className="admin-page">
    <div className="section-heading"><div><p className="eyebrow"><ShieldCheck /> {t("ADMINISTRATOR")}</p><h2>{t("BRIDGE")} <em>//</em> {t("CONFIGURATION")}</h2></div>
      <div className="button-pair"><Link href="/setup" className="outline-button"><Rocket /> {t("SETUP WIZARD")}</Link><Link href="/diagnostics" className="outline-button"><Stethoscope /> {t("SYSTEM CHECK")}</Link></div></div>
    <nav ref={tabs} className="admin-tabs" aria-label={t("Admin sections")}>
      {ADMIN_SECTIONS.map(id => { const Icon = SECTION_ICONS[id]; return <Link key={id} href={`/admin/${id}`} className={`admin-tab ${id === section ? "active" : ""}`} aria-current={id === section ? "page" : undefined}><Icon /> {adminSectionLabel(id)}</Link>; })}
    </nav>
    <p className="muted-copy admin-summary">{adminSectionSummary(section)}</p>
    {section === "connection" && <div className="admin-grid admin-grid-narrow"><CasambiLinkPanel api={api} connectionStatus={connection} refresh={refresh} /></div>}
    {section === "rooms" && <div className="admin-grid"><HudFrame className="form-panel"><RoomsPanel api={api} rooms={network?.rooms ?? []} onChanged={refresh} onNotice={notify} /></HudFrame><DeviceMetadataPanel api={api} network={network} refresh={() => refresh()} onNotice={notify} /></div>}
    {section === "automation" && <div className="admin-grid"><SwitchRulesPanel api={api} onNotice={notify} /><div className="admin-stack"><AwayDateSetsPanel api={api} onNotice={notify} /><SolarLocationPanel api={api} onNotice={notify} /></div></div>}
    {section === "access" && <div className="admin-grid"><HudFrame className="form-panel"><AccountsPanel api={api} onNotice={notify} /></HudFrame><ApiKeysPanel api={api} onNotice={notify} /></div>}
    {section === "homekit" && <div className="admin-grid"><HomeKitPanel api={api} onNotice={notify} /><AccessoriesPanel api={api} onNotice={notify} app="Apple Home" title={t("IN APPLE HOME")} statusPath="/admin/homekit" savePath="/admin/homekit/accessories" hint={<p className="muted-copy">{t("A Casambi wall switch appears here after each of its buttons was pressed once while the Pi is connected; in the Home app you then choose what a tap or a hold of each button does.")}</p>} /></div>}
    {section === "google" && <div className="admin-grid"><MatterPanel api={api} onNotice={notify} /><AccessoriesPanel api={api} onNotice={notify} app="Google Home" title={t("IN GOOGLE HOME")} statusPath="/admin/matter" savePath="/admin/matter/accessories" hint={<p className="muted-copy">{t("A Casambi wall switch appears here after each of its buttons was pressed once while the Pi is connected (separately from HomeKit). In Google Home each button is then a starter for automations: press, long press, and release after a long press.")}</p>} /></div>}
    {section === "system" && <div className="admin-grid"><NotificationsPanel api={api} onNotice={notify} /><UpdatePanel api={api} onNotice={notify} /><BackupPanel api={api} onNotice={notify} /><ServerSettingsPanel api={api} onNotice={notify} /><div className="admin-wide"><AuditLogPanel api={api} onNotice={notify} /></div></div>}
  </div>;
}

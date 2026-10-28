import { Activity, BookOpen, CalendarClock, CircuitBoard, LogOut, Settings2, ShieldCheck, Stethoscope } from "lucide-react";
import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Role } from "@/lib/localApi";

const nav = [{ href: "/", label: "CONTROL", icon: CircuitBoard }, { href: "/schedules", label: "TIMERS", icon: CalendarClock }];

/** Persistent HUD navigation for authenticated appliance sessions. */
export function AppShell({ role, username, onLogout, children }: { role: Role; username: string; onLogout: () => void; children: ReactNode }) {
  const [location] = useLocation();
  // The API reference and diagnostics are desktop entries; the phone navigation stays at three tabs (see .rail-link.desktop-only),
  // and phones reach diagnostics from the Admin page.
  const items = role === "admin" ? [...nav, { href: "/admin", label: "ADMIN", icon: Settings2 }, { href: "/diagnostics", label: "DIAGNOSE", icon: Stethoscope, desktopOnly: true }, { href: "/api", label: "API", icon: BookOpen, desktopOnly: true }] : nav;
  return <div className="app-shell">
    <aside className="side-rail">
      <div className="brand-mark"><span>CB</span><small>Casambi BT<br />WebGUI</small></div>
      <nav>{items.map(item => <Link key={item.href} href={item.href} className={`rail-link ${location === item.href ? "active" : ""} ${"desktopOnly" in item && item.desktopOnly ? "desktop-only" : ""}`}><item.icon /><span>{item.label}</span></Link>)}</nav>
      <div className="rail-bottom"><div className="identity"><ShieldCheck /><div><strong>{username}</strong><small>{role}</small></div></div><button className="icon-button" onClick={onLogout} aria-label="Sign out"><LogOut /></button></div>
    </aside>
    <main className="main-stage"><header className="topbar"><div><p className="eyebrow"><Activity /> LIVE LIGHTING CONTROL</p><h1>Casambi BT <em>WebGUI</em></h1></div><div className="system-pulse"><span /> RASPBERRY PI // LOCAL</div></header>{children}</main>
  </div>;
}

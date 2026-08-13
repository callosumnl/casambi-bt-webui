import { Activity, CalendarClock, CircuitBoard, LogOut, Settings2, ShieldCheck } from "lucide-react";
import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Role } from "@/lib/localApi";

const nav = [{ href: "/", label: "CONTROL", icon: CircuitBoard }, { href: "/schedules", label: "TIMERS", icon: CalendarClock }];

/** Persistent HUD navigation for authenticated appliance sessions. */
export function AppShell({ role, username, onLogout, children, demo = false }: { role: Role; username: string; onLogout: () => void; children: ReactNode; demo?: boolean }) {
  const [location] = useLocation();
  const items = role === "admin" ? [...nav, { href: "/admin", label: "ADMIN", icon: Settings2 }] : nav;
  return <div className="app-shell">
    <aside className="side-rail">
      <div className="brand-mark"><span>CB</span><small>CASAMBI<br />CONTROL</small></div>
      <nav>{items.map(item => <Link key={item.href} href={item.href} className={`rail-link ${location === item.href ? "active" : ""}`}><item.icon /><span>{item.label}</span></Link>)}</nav>
      <div className="rail-bottom"><div className="identity"><ShieldCheck /><div><strong>{username}</strong><small>{demo ? "anonymous demo" : role}</small></div></div><button className="icon-button" onClick={onLogout} aria-label={demo ? "Exit demo" : "Sign out"}><LogOut /></button></div>
    </aside>
    <main className="main-stage"><header className="topbar"><div><p className="eyebrow"><Activity /> {demo ? "SIMULATED LIGHTING CONTROL" : "LIVE LIGHTING CONTROL"}</p><h1>NEON <em>GRID</em></h1></div><div className="system-pulse"><span /> {demo ? "DEMO // NO HARDWARE" : "RASPBERRY PI // LOCAL"}</div></header>{children}</main>
  </div>;
}

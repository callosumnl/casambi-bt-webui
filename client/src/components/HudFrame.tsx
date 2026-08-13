import { ReactNode } from "react";

/** Thin technical corner brackets used consistently across the HUD interface. */
export function HudFrame({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`hud-frame ${className}`}><i className="hud-corner tl" /><i className="hud-corner tr" /><i className="hud-corner bl" /><i className="hud-corner br" />{children}</section>;
}

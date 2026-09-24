import { Lightbulb, Power, SlidersHorizontal, ThermometerSun, WifiOff } from "lucide-react";
import { useSliderCommit } from "@/hooks/useSliderCommit";
import { Device } from "@/lib/localApi";
import { dimmerToPercent, percentToDimmer } from "@/lib/brightness";
import { HudFrame } from "./HudFrame";

/** A capability-aware lamp card that exposes only controls reported by Casambi. */
export function DeviceControlCard({ device, onCommand }: { device: Device; onCommand: (payload: unknown) => Promise<void> }) {
  const supports = (type: string) => device.capabilities.some(capability => capability.type === type);
  const busyCommand = (operation: string, value?: unknown) => void onCommand({ targetType: "unit", targetId: device.id, operation, ...(value !== undefined ? { value } : {}) });
  const sendCommand = (operation: string, value: unknown) => onCommand({ targetType: "unit", targetId: device.id, operation, value });
  const brightness = useSliderCommit(dimmerToPercent(device.state.dimmer), percent => sendCommand("set_level", percentToDimmer(percent)));
  const temperature = useSliderCommit(device.state.temperature ?? 4000, kelvin => sendCommand("set_temperature", kelvin));
  return <HudFrame className={`device-card ${device.state.on ? "lit" : ""}`}>
    <div className="device-top"><div className="device-icon"><Lightbulb /></div><div className="device-title"><h3>{device.name}</h3><p>{device.roomName || device.model || "UNASSIGNED"}</p></div><span className={`status-dot ${device.state.online ? "online" : "offline"}`}>{device.state.online ? "LIVE" : <WifiOff />}</span></div>
    <div className="power-line"><span>{device.state.on ? "ACTIVE" : "STANDBY"}</span><button className="power-button" onClick={() => busyCommand(device.state.on ? "off" : "on")} aria-label={`Turn ${device.name} ${device.state.on ? "off" : "on"}`}><Power /></button></div>
    {supports("dimmer") && <label className="control-row"><span><SlidersHorizontal /> BRIGHTNESS <b>{brightness.value}%</b></span><input type="range" min="0" max="100" value={brightness.value} {...brightness.handlers} /></label>}
    {supports("temperature") && <label className="control-row"><span><ThermometerSun /> TEMPERATURE <b>{device.state.temperature == null && !temperature.adjusting ? "—" : temperature.value}K</b></span><input type="range" min="2700" max="6500" step="50" value={temperature.value} {...temperature.handlers} /></label>}
  </HudFrame>;
}

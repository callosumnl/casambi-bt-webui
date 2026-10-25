import { Power, WifiOff } from "lucide-react";
import { useSliderCommit } from "@/hooks/useSliderCommit";
import { Device } from "@/lib/localApi";
import { dimmerToPercent, percentToDimmer } from "@/lib/brightness";

/** A compact lamp control: name, power toggle, and only the sliders the fixture reports. */
export function DeviceControlCard({ device, onCommand }: { device: Device; onCommand: (payload: unknown) => Promise<void> }) {
  const supports = (type: string) => device.capabilities.some(capability => capability.type === type);
  const sendCommand = (operation: string, value?: unknown) => onCommand({ targetType: "unit", targetId: device.id, operation, ...(value !== undefined ? { value } : {}) });
  const brightness = useSliderCommit(dimmerToPercent(device.state.dimmer), percent => sendCommand("set_level", percentToDimmer(percent)));
  const temperature = useSliderCommit(device.state.temperature ?? 4000, kelvin => sendCommand("set_temperature", kelvin));
  return <article className={`lamp-card ${device.state.on ? "lit" : ""} ${device.state.online ? "" : "offline"}`}>
    <div className="lamp-head">
      <div><h3>{device.name}</h3>{device.roomName && <p>{device.roomName}</p>}</div>
      {!device.state.online && <span className="lamp-offline"><WifiOff /> OFFLINE</span>}
      <button className="lamp-power" aria-pressed={device.state.on} onClick={() => void sendCommand(device.state.on ? "off" : "on")} aria-label={`Turn ${device.name} ${device.state.on ? "off" : "on"}`}><Power /></button>
    </div>
    {supports("dimmer") && <label className="lamp-slider"><span>DIM</span><input type="range" min="0" max="100" value={brightness.value} aria-label={`${device.name} brightness`} {...brightness.handlers} /><b>{brightness.value}%</b></label>}
    {supports("temperature") && <label className="lamp-slider"><span>TEMP</span><input type="range" min="2700" max="6500" step="50" value={temperature.value} aria-label={`${device.name} colour temperature`} {...temperature.handlers} /><b>{device.state.temperature == null && !temperature.adjusting ? "—" : `${temperature.value}K`}</b></label>}
  </article>;
}

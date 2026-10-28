import { Power, WifiOff } from "lucide-react";
import { useSliderCommit } from "@/hooks/useSliderCommit";
import { Device } from "@/lib/localApi";
import { dimmerToPercent, percentToDimmer } from "@/lib/brightness";
import { t } from "@/lib/i18n";

/** A compact lamp control: name, power toggle, and only the sliders the fixture reports. */
export function DeviceControlCard({ device, onCommand }: { device: Device; onCommand: (payload: unknown) => Promise<void> }) {
  const supports = (type: string) => device.capabilities.some(capability => capability.type === type);
  const sendCommand = (operation: string, value?: unknown) => onCommand({ targetType: "unit", targetId: device.id, operation, ...(value !== undefined ? { value } : {}) });
  const brightness = useSliderCommit(dimmerToPercent(device.state.dimmer), percent => sendCommand("set_level", percentToDimmer(percent)));
  const range = device.capabilities.find(capability => capability.type === "temperature");
  const [minKelvin, maxKelvin] = [range?.min ?? 2700, range?.max ?? 6500];
  const temperature = useSliderCommit(device.state.temperature ?? Math.round((minKelvin + maxKelvin) / 2), kelvin => sendCommand("set_temperature", kelvin));
  return <article className={`lamp-card ${device.state.on ? "lit" : ""} ${device.state.online ? "" : "offline"}`}>
    <div className="lamp-head">
      <div><h3>{device.name}</h3>{device.roomName && <p>{device.roomName}</p>}</div>
      {!device.state.online && <span className="lamp-offline"><WifiOff /> {t("OFFLINE")}</span>}
      <button className="lamp-power" aria-pressed={device.state.on} onClick={() => void sendCommand(device.state.on ? "off" : "on")} aria-label={device.state.on ? t("Turn {name} off", { name: device.name }) : t("Turn {name} on", { name: device.name })}><Power /></button>
    </div>
    {supports("dimmer") && <label className="lamp-slider"><span>{t("DIM")}</span><input type="range" min="0" max="100" value={brightness.value} aria-label={t("{name} brightness", { name: device.name })} {...brightness.handlers} /><b>{brightness.value}%</b></label>}
    {supports("temperature") && <label className="lamp-slider"><span>{t("TEMP")}</span><input type="range" min={minKelvin} max={maxKelvin} step="50" value={temperature.value} aria-label={t("{name} colour temperature", { name: device.name })} {...temperature.handlers} /><b>{device.state.temperature == null && !temperature.adjusting ? "—" : `${temperature.value}K`}</b></label>}
  </article>;
}

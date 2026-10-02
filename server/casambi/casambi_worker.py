#!/usr/bin/env python3
"""JSON-lines worker that isolates Casambi Bluetooth access from the Node.js service.

The worker intentionally exposes only documented, capability-aware operations from
the `casambi-bt` package. It emits protocol data to stdout and diagnostic data to
stderr, keeping the Node.js JSON-lines channel machine-readable.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import signal
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def emit(payload: dict[str, Any]) -> None:
    """Write one protocol envelope and flush it immediately."""
    print(json.dumps(payload, separators=(",", ":"), default=str), flush=True)


# Upstream reports each button action twice. The type 0x08 message's press/release
# label is derived from one bit of a sequence counter and flips whenever the counter
# skips, so it is unreliable. The type 0x10 message carries a real state byte, so
# only its states become triggers; everything else is forwarded as raw activity.
SWITCH_TRIGGERS = {"RELEASE": "tap", "HOLD": "hold", "RELEASE_AFTER_HOLD": "release_after_hold"}


def normalize_switch_event(event: Any) -> dict[str, Any]:
    """Convert an upstream SwitchEvent into a JSON-friendly trigger, keeping the raw fields for diagnosis."""
    state = getattr(event, "event", None)
    kind = getattr(state, "name", None) or str(state)
    message_type = getattr(event, "message_type", None)
    extra = getattr(event, "extra_data", b"") or b""
    return {
        "unitId": getattr(event, "unit_id", None),
        "button": getattr(event, "button", None),
        "trigger": SWITCH_TRIGGERS.get(kind) if message_type == 0x10 else None,
        "raw": {
            "messageType": message_type,
            "event": kind,
            "action": getattr(event, "action", None),
            "flags": getattr(event, "flags", None),
            "extraData": extra.hex() if isinstance(extra, (bytes, bytearray)) else str(extra),
        },
    }


# Well inside systemd's 20 s TimeoutStopSec, so a clean disconnect never turns into a SIGKILL.
SHUTDOWN_DISCONNECT_SECONDS = 5
# Bounds for the BlueZ steps before a (re)connect. Their D-Bus calls have no timeout of their own,
# and after a dropped link one of them once hung for 32 hours. The connect itself stays unbounded
# here (a healthy one has taken 42 s); Node's 90 s command timeout and watchdog cover it.
PREVIOUS_DISCONNECT_TIMEOUT_SECONDS = 8
DISCOVERY_TIMEOUT_SECONDS = 20


async def discover_with_timeout(discover: Any) -> list[Any]:
    """Run an upstream Bluetooth scan, failing clearly instead of waiting forever on BlueZ."""
    try:
        return await asyncio.wait_for(discover(), timeout=DISCOVERY_TIMEOUT_SECONDS)
    except TimeoutError as error:
        raise RuntimeError(
            f"Bluetooth scan timed out after {DISCOVERY_TIMEOUT_SECONDS} s; BlueZ did not answer. "
            "Restarting the Pi's bluetooth service usually clears this."
        ) from error


def utc_now() -> str:
    """Return an ISO-8601 timestamp for snapshot and event ordering."""
    return datetime.now(UTC).isoformat()


def normalize_network_address(value: Any) -> str:
    """Return a canonical colon-delimited BLE address accepted by casambi-bt.

    The upstream library accepts a BLE address but its colon-free branch currently
    references an uninitialized variable. Accept both common user-entered forms
    here and always call the upstream client with a valid canonical address.
    """
    if not isinstance(value, str):
        raise ValueError("Network address must be a 12-digit hexadecimal Bluetooth address.")
    compact = value.strip().replace(":", "").replace("-", "")
    if not re.fullmatch(r"[0-9A-Fa-f]{12}", compact):
        raise ValueError("Network address must contain exactly 12 hexadecimal digits, for example AB:CD:EF:01:23:45.")
    return ":".join(compact[index : index + 2] for index in range(0, 12, 2)).upper()


@dataclass
class MockUnit:
    """Deterministic development fixture used only when --mock is explicit."""

    id: int
    name: str
    dimmer: int
    temperature: int
    on: bool = True

    def serialize(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "uuid": f"mock-unit-{self.id}",
            "address": f"00:00:00:00:00:{self.id:02d}",
            "name": self.name,
            "firmwareVersion": "mock",
            "model": "Development fixture",
            "manufacturer": "Casambi BT WebUI",
            "capabilities": [
                {"type": "dimmer", "min": 0, "max": 255, "readOnly": False},
                {"type": "temperature", "min": 2700, "max": 6500, "readOnly": False},
                {"type": "onoff", "readOnly": False},
            ],
            "state": {"dimmer": self.dimmer, "temperature": self.temperature, "sensors": [{"label": "Ambient light", "value": 420, "unit": "lux"}], "on": self.on, "online": True},
        }


class CasambiWorker:
    """Owns a single live Casambi connection and normalizes upstream data."""

    def __init__(self, mock: bool) -> None:
        self.mock = mock
        self.casa: Any | None = None
        self.connected = False
        self.mock_units = [MockUnit(1, "Studio light", 180, 4000), MockUnit(2, "Entry light", 110, 3000)]

    def snapshot(self) -> dict[str, Any]:
        """Return only data currently modeled by the upstream library."""
        if self.mock:
            return {
                "connected": self.connected,
                "network": {"id": "mock-network", "name": "Development network"} if self.connected else None,
                "units": [unit.serialize() for unit in self.mock_units],
                "groups": [{"id": 1, "name": "Demo group", "unitIds": [1, 2]}],
                "scenes": [{"id": 1, "name": "Demo scene"}],
                "updatedAt": utc_now(),
            }
        if not self.casa or not self.connected:
            return {"connected": False, "network": None, "units": [], "groups": [], "scenes": [], "updatedAt": utc_now()}
        return {
            "connected": True,
            "network": {"id": self.casa.networkId, "name": self.casa.networkName},
            "units": [self.serialize_unit(unit) for unit in self.casa.units],
            "groups": [{"id": group.groudId, "name": group.name, "unitIds": [unit.deviceId for unit in group.units]} for group in self.casa.groups],
            "scenes": [{"id": scene.sceneId, "name": scene.name} for scene in self.casa.scenes],
            "updatedAt": utc_now(),
        }

    def serialize_unit(self, unit: Any) -> dict[str, Any]:
        """Convert the upstream Unit model without depending on private protocol bytes."""
        state = unit.state
        sensor_values: dict[int, int] = getattr(unit, "_webui_sensor_values", {})
        return {
            "id": unit.deviceId,
            "uuid": unit.uuid,
            "address": unit.address,
            "name": unit.name,
            "firmwareVersion": unit.firmwareVersion,
            "model": unit.unitType.model,
            "manufacturer": unit.unitType.manufacturer,
            "capabilities": [{"type": control.type.name.lower(), "min": control.min, "max": control.max, "readOnly": control.readonly} for control in unit.unitType.controls],
            "state": {
                "dimmer": state.dimmer if state else None,
                "temperature": state.temperature if state else None,
                "rgb": list(state.rgb) if state and state.rgb else None,
                "white": state.white if state else None,
                "vertical": state.vertical if state else None,
                "slider": state.slider if state else None,
                "xy": list(state.xy) if state and state.xy else None,
                "sensors": [{"label": f"Sensor @ bit {control.offset}", "value": sensor_values.get(control.offset), "unit": "raw" if control.offset in sensor_values else None} for control in unit.unitType.controls if control.type.name == "SENSOR"],
                "on": unit.is_on,
                "online": unit.online,
            },
        }

    def instrument_sensor_state(self, unit: Any) -> None:
        """Capture raw SENSOR control bits before the upstream parser discards them.

        The upstream library exposes SENSOR capabilities but does not retain every
        sensor value in UnitState. This wrapper preserves only incoming sensor
        bitfields and then delegates unchanged to the upstream state parser.
        Values are deliberately labelled `raw` because per-fixture engineering
        unit conversion is not defined by the upstream package.
        """
        controls = [control for control in unit.unitType.controls if control.type.name == "SENSOR"]
        if not controls or getattr(unit, "_webui_sensor_instrumented", False):
            return
        original = unit.setStateFromBytes
        unit._webui_sensor_values = {}

        def capture_sensor_state(value: bytes) -> None:
            for control in controls:
                byte_length = (control.length + control.offset % 8 - 1) // 8 + 1
                control_bytes = value[control.offset // 8 : control.offset // 8 + byte_length]
                parsed = int.from_bytes(control_bytes, byteorder="little", signed=False)
                parsed >>= control.offset % 8
                unit._webui_sensor_values[control.offset] = parsed & (2**control.length - 1)
            original(value)

        unit.setStateFromBytes = capture_sensor_state
        unit._webui_sensor_instrumented = True

    async def configure(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Connect using the network address and password supported by casambi-bt."""
        if self.mock:
            self.connected = True
            emit({"event": {"type": "bridge", "state": "connected", "detail": "Development bridge connected."}})
            return self.snapshot()
        from CasambiBt import Casambi, discover  # Imported only in live mode for a clean development experience.

        address = payload.get("networkAddress") or payload.get("networkUuid")
        password = payload.get("networkPassword")
        if not address or not password:
            raise ValueError("networkAddress/networkUuid and networkPassword are required to connect.")
        address = normalize_network_address(address)
        if self.casa:
            # Detach first, so a late callback from the old instance is ignored by handle_disconnect.
            previous, self.casa = self.casa, None
            self.connected = False
            try:
                await asyncio.wait_for(previous.disconnect(), timeout=PREVIOUS_DISCONNECT_TIMEOUT_SECONDS)
            except Exception as error:  # Includes TimeoutError. The new connection does not depend on the old one.
                print(f"Closing the previous Casambi connection did not finish ({error!r}); continuing with a new connection.", file=sys.stderr, flush=True)
        # Keep the BLEDevice returned by a fresh discovery scan. Passing a raw
        # address makes casambi-bt perform a second BlueZ cache lookup after its
        # network update work; BlueZ can expire that cached object meanwhile,
        # leading to an empty NetworkNotFoundError despite a successful scan.
        endpoints = await discover_with_timeout(discover)
        endpoint = next((device for device in endpoints if device.address.upper() == address), None)
        if endpoint is None:
            raise RuntimeError(
                f"The Raspberry Pi cannot currently discover Casambi BLE endpoint {address}. "
                "Move the Pi or its antenna nearer to a powered Casambi unit, then run Discover and retry."
            )
        # casambi-bt otherwise writes its cache relative to the process working
        # directory. The production service deliberately runs with a read-only
        # application directory, so keep upstream state in the service-owned
        # data directory instead. Development retains the repository-local
        # behavior unless an explicit path is supplied.
        cache_path = os.environ.get("CASAMBI_CACHE_PATH")
        if cache_path is None:
            cache_path = str(Path.cwd() / "casambi-bt-store") if os.environ.get("NODE_ENV") == "development" else "/var/lib/casambi-bt-webui/casambi-bt-store"
        casa = Casambi(cachePath=Path(cache_path))
        self.casa = casa
        casa.registerUnitChangedHandler(self.handle_unit_changed)
        casa.registerSwitchEventHandler(self.handle_switch_event)
        casa.registerDisconnectCallback(lambda: self.handle_disconnect(casa))
        try:
            await self.casa.connect(endpoint, password, bool(payload.get("forceOffline", False)))
        except Exception as error:
            # casambi-bt uses a blank NetworkNotFoundError both when a cloud
            # lookup is unavailable and when BlueZ cannot rediscover the local
            # BLE endpoint. The cloud branch includes a message; make the
            # otherwise opaque direct-Bluetooth branch actionable.
            if type(error).__name__ == "NetworkNotFoundError" and not str(error):
                raise RuntimeError(
                    f"Casambi cloud data was resolved, but the Raspberry Pi Bluetooth adapter could not discover local BLE endpoint {address}. "
                    "Use Discover while the Pi is near a powered Casambi unit, verify the casambi service account has Bluetooth access, and retry."
                ) from error
            raise
        for unit in self.casa.units:
            self.instrument_sensor_state(unit)
        self.connected = True
        emit({"event": {"type": "bridge", "state": "connected"}})
        return self.snapshot()

    def handle_unit_changed(self, unit: Any) -> None:
        """Forward asynchronous unit updates to Node.js."""
        emit({"event": {"type": "unit.state", "unit": self.serialize_unit(unit)}})

    def handle_switch_event(self, event: Any) -> None:
        """Forward physical switch activity for audit and optional client feedback."""
        emit({"event": {"type": "switch", "press": normalize_switch_event(event)}})

    def handle_disconnect(self, source: Any = None) -> None:
        """Report a remote Bluetooth disconnect."""
        # A late callback from a connection this worker already replaced must not
        # mark the new connection as lost (Node would then reconnect needlessly).
        if source is not None and source is not self.casa:
            return
        self.connected = False
        emit({"event": {"type": "bridge", "state": "disconnected"}})

    async def discover(self) -> list[dict[str, str]]:
        """Discover nearby Casambi networks through the upstream filtering logic."""
        if self.mock:
            return [{"address": "00:00:00:00:00:01"}]
        from CasambiBt import discover

        return [{"address": device.address} for device in await discover_with_timeout(discover)]

    async def control(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Run one validated control request against a unit, group, scene, or network."""
        target_type = payload["targetType"]
        target_id = payload.get("targetId")
        operation = payload["operation"]
        value = payload.get("value")
        if self.mock:
            for unit in self.mock_units:
                if target_type in ("network", "group") or str(unit.id) == str(target_id):
                    if operation == "on": unit.on = True
                    elif operation == "off": unit.on = False; unit.dimmer = 0
                    elif operation == "set_level": unit.dimmer = int(value); unit.on = unit.dimmer > 0
                    elif operation == "set_temperature": unit.temperature = int(value)
                    emit({"event": {"type": "unit.state", "unit": unit.serialize()}})
            return self.snapshot()
        if not self.casa or not self.connected:
            raise RuntimeError("The Casambi bridge is not connected.")
        target: Any = None
        if target_type == "unit": target = next((unit for unit in self.casa.units if unit.deviceId == int(target_id)), None)
        elif target_type == "group": target = next((group for group in self.casa.groups if group.groudId == int(target_id)), None)
        elif target_type == "scene": target = next((scene for scene in self.casa.scenes if scene.sceneId == int(target_id)), None)
        if target_type != "network" and target is None:
            raise ValueError("The requested Casambi target does not exist.")
        if operation == "on": await self.casa.turnOn(target)
        elif operation == "off": await self.casa.setLevel(target, 0)
        elif operation == "set_level": await self.casa.setLevel(target, int(value))
        elif operation == "set_temperature": await self.casa.setTemperature(target, int(value))
        elif operation == "set_color": await self.casa.setColor(target, tuple(value))
        elif operation == "set_white": await self.casa.setWhite(target, int(value))
        elif operation == "set_vertical": await self.casa.setVertical(target, int(value))
        elif operation == "set_slider": await self.casa.setSlider(target, int(value))
        elif operation == "set_xy": await self.casa.setColorXY(target, tuple(value))
        elif operation == "activate_scene": await self.casa.switchToScene(target, int(value) if value is not None else 255)
        else: raise ValueError(f"Unsupported control operation: {operation}")
        return self.snapshot()

    async def shutdown(self) -> None:
        """Release the BLE link before the worker exits.

        BlueZ owns a connection, not the process that opened it, so a worker that
        exits without disconnecting leaves the Pi holding the link and the next
        worker's connect attempts fail until it is cleared.
        """
        if self.casa is None:
            return
        try:
            await asyncio.wait_for(self.casa.disconnect(), timeout=SHUTDOWN_DISCONNECT_SECONDS)
        except Exception as error:  # Best effort: never block or crash the exit path.
            print(f"Shutdown disconnect failed: {error!r}", file=sys.stderr, flush=True)

    async def disconnect(self) -> dict[str, Any]:
        """Disconnect cleanly and preserve the worker process for a later reconnect."""
        if self.casa: await self.casa.disconnect()
        self.connected = False
        emit({"event": {"type": "bridge", "state": "disconnected"}})
        return self.snapshot()


async def run_worker(mock: bool) -> None:
    """Read JSON-lines commands one at a time, ensuring Bluetooth calls remain ordered."""
    worker = CasambiWorker(mock)
    # SIGTERM (systemd stop, Node's bridge.stop) and SIGINT (Ctrl-C in development) cancel the
    # loop so the finally block can disconnect; stdin EOF (Node exited) ends the loop normally.
    main_task = asyncio.current_task()
    stop_requested = False

    def request_stop() -> None:
        nonlocal stop_requested
        # systemd signals every process in the unit and Node's bridge.stop() signals the worker
        # again, so SIGTERM usually arrives twice; a second cancel would abort the disconnect.
        if stop_requested:
            return
        stop_requested = True
        if main_task is not None:
            main_task.cancel()

    loop = asyncio.get_running_loop()
    for stop_signal in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(stop_signal, request_stop)
    emit({"event": {"type": "bridge", "state": "connected" if mock else "starting"}})
    try:
        await serve_commands(worker)
    except asyncio.CancelledError:
        if not stop_requested:
            raise
    finally:
        await worker.shutdown()
    if stop_requested:
        # The stdin reader thread may still be blocked in readline(); asyncio.run would wait for it.
        try:
            sys.stdout.flush()
        except OSError:  # Node may already have closed the pipe.
            pass
        os._exit(0)


async def serve_commands(worker: CasambiWorker) -> None:
    """Handle commands until stdin closes."""
    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line: break
        try:
            request = json.loads(line)
            command = request["command"]
            payload = request.get("payload", {})
            if command == "ping": result = {"ok": True}
            elif command == "discover": result = await worker.discover()
            elif command in ("configure", "connect"): result = await worker.configure(payload)
            elif command == "disconnect": result = await worker.disconnect()
            elif command == "snapshot": result = worker.snapshot()
            elif command == "control": result = await worker.control(payload)
            else: raise ValueError(f"Unknown bridge command: {command}")
            emit({"id": request["id"], "ok": True, "result": result})
        except Exception as error:  # The protocol must never crash the service for a malformed command.
            emit({"id": request.get("id", "unknown"), "ok": False, "error": {"code": type(error).__name__, "message": str(error)}})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--mock", action="store_true", help="Use deterministic development fixtures instead of Bluetooth.")
    args = parser.parse_args()
    asyncio.run(run_worker(args.mock))

"""Safe local deployment utilities distributed with the PyPI companion package."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from importlib.resources import files
from pathlib import Path
from typing import Any

from . import __version__


def _node_version() -> str | None:
    """Return the available Node.js version without raising when Node is absent."""
    executable = shutil.which("node")
    if executable is None:
        return None
    completed = subprocess.run([executable, "--version"], check=False, capture_output=True, text=True)
    return completed.stdout.strip() if completed.returncode == 0 else None


def doctor(as_json: bool) -> int:
    """Report the local prerequisites required by the separately deployed Node.js UI."""
    node_version = _node_version()
    bluetooth_paths = sorted(Path("/sys/class/bluetooth").glob("hci*")) if Path("/sys/class/bluetooth").exists() else []
    report: dict[str, Any] = {
        "python": sys.version.split()[0],
        "python_supported": sys.version_info >= (3, 11),
        "node": node_version,
        "node_supported": bool(node_version and int(node_version.removeprefix("v").split(".")[0]) >= 22),
        "bluetooth_adapters": [path.name for path in bluetooth_paths],
        "casambi_bt_webui_home": os.environ.get("CASAMBI_WEBUI_HOME"),
    }
    if as_json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(f"Python: {report['python']} ({'supported' if report['python_supported'] else 'requires 3.11+'})")
        print(f"Node.js: {node_version or 'not found'} ({'supported' if report['node_supported'] else 'requires 22+'})")
        print(f"Bluetooth adapters: {', '.join(report['bluetooth_adapters']) or 'none detected'}")
        print(f"WebUI source: {report['casambi_bt_webui_home'] or 'set CASAMBI_WEBUI_HOME when deployed outside /opt'}")
    return 0 if report["python_supported"] and report["node_supported"] else 1


def template_text(name: str) -> str:
    """Read a bundled non-secret deployment template by its controlled filename."""
    allowed = {"casambi-bt-webui.service", "environment.template"}
    if name not in allowed:
        raise ValueError(f"Unsupported template: {name}")
    return files("casambi_bt_webui").joinpath("templates", name).read_text(encoding="utf-8")


def write_templates(destination: Path) -> int:
    """Write editable service and environment templates without overwriting existing files."""
    destination.mkdir(parents=True, exist_ok=True)
    for name in ("casambi-bt-webui.service", "environment.template"):
        target = destination / name
        if target.exists():
            print(f"Refusing to overwrite existing template: {target}", file=sys.stderr)
            return 2
        target.write_text(template_text(name), encoding="utf-8")
        print(f"Wrote {target}")
    return 0


def main() -> int:
    """Run the installed console entry point."""
    parser = argparse.ArgumentParser(description="Casambi BT WebUI Raspberry Pi deployment companion")
    parser.add_argument("--version", action="version", version=__version__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    doctor_parser = subparsers.add_parser("doctor", help="inspect Python, Node.js, and Bluetooth prerequisites")
    doctor_parser.add_argument("--json", action="store_true", help="emit machine-readable diagnostics")
    subparsers.add_parser("systemd-template", help="print the packaged systemd service template")
    write_parser = subparsers.add_parser("write-templates", help="write non-secret deployment templates to a new directory")
    write_parser.add_argument("--directory", type=Path, required=True, help="empty or new target directory")
    args = parser.parse_args()
    if args.command == "doctor":
        return doctor(args.json)
    if args.command == "systemd-template":
        print(template_text("casambi-bt-webui.service"), end="")
        return 0
    return write_templates(args.directory)


if __name__ == "__main__":
    raise SystemExit(main())

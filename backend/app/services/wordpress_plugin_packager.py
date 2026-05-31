"""Build a WordPress-uploadable ZIP for the Riviso connector plugin."""

from __future__ import annotations

import io
import os
import re
import zipfile
from pathlib import Path

PLUGIN_SLUG = "riviso-content-operations"
# WordPress standard: folder slug matches bootstrap PHP file (folder/folder.php).
PLUGIN_BOOTSTRAP = f"{PLUGIN_SLUG}.php"
PLUGIN_LEGACY_BOOTSTRAP = "plugin.php"
PLUGIN_BUNDLE_FILES = (
    PLUGIN_BOOTSTRAP,
    PLUGIN_LEGACY_BOOTSTRAP,
    "includes/connector.php",
    "includes/index.php",
    "index.php",
    "readme.txt",
    "uninstall.php",
)
_VERSION_RE = re.compile(rb"^\s*\*\s*Version:\s*([0-9.]+)\s*$", re.MULTILINE)


def resolve_plugin_source_dir() -> Path:
    """Prefer backend/wordpress_plugin (Docker + canonical source)."""
    here = Path(__file__).resolve()
    candidates: list[Path] = [
        here.parents[2] / "wordpress_plugin" / PLUGIN_SLUG,
        here.parents[3] / "backend" / "wordpress_plugin" / PLUGIN_SLUG,
        here.parents[3] / "wordpress_plugin" / PLUGIN_SLUG,
        Path("/app/backend/wordpress_plugin") / PLUGIN_SLUG,
        Path("/app/wordpress_plugin") / PLUGIN_SLUG,
    ]
    for path in candidates:
        if path.is_dir() and (path / PLUGIN_BOOTSTRAP).is_file():
            return path
    raise FileNotFoundError(
        "Riviso WordPress plugin source directory not found on server"
    )


def get_plugin_version() -> str:
    bootstrap = resolve_plugin_source_dir() / PLUGIN_BOOTSTRAP
    data = bootstrap.read_bytes()
    match = _VERSION_RE.search(data[:8192])
    if not match:
        return "0.0.0"
    return match.group(1).decode("ascii", errors="replace")


def _arcname_for(rel_path: str) -> str:
    return f"{PLUGIN_SLUG}/{rel_path.replace(os.sep, '/')}"


def _strip_utf8_bom(data: bytes) -> bytes:
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:]
    return data


def _assert_plugin_header(data: bytes, arcname: str) -> None:
    if not re.search(rb"Plugin Name\s*:", data[:8192]):
        raise ValueError(f"ZIP entry {arcname} is missing a WordPress Plugin Name header")


def _assert_no_plugin_header(data: bytes, arcname: str) -> None:
    if re.search(rb"Plugin Name\s*:", data[:8192]):
        raise ValueError(f"ZIP entry {arcname} must not declare a second Plugin Name header")


def _assert_wpinc_guard(data: bytes, arcname: str) -> None:
    if not re.search(rb"defined\s*\(\s*['\"]WPINC['\"]\s*\)", data[:4096]):
        raise ValueError(f"ZIP entry {arcname} is missing the WPINC direct-access guard")


def validate_plugin_zip(data: bytes) -> None:
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = zf.namelist()
        roots = {n.split("/")[0] for n in names if "/" in n}
        if roots != {PLUGIN_SLUG}:
            raise ValueError(
                f"Plugin ZIP must contain one top-level folder named {PLUGIN_SLUG!r}; got {sorted(roots)!r}"
            )
        nested = [n for n in names if n.startswith(f"{PLUGIN_SLUG}/{PLUGIN_SLUG}/")]
        if nested:
            raise ValueError(
                f"Plugin ZIP is double-nested (remove extra folder level): {nested[:3]}"
            )
        bootstrap = f"{PLUGIN_SLUG}/{PLUGIN_BOOTSTRAP}"
        if bootstrap not in names:
            raise ValueError(f"Plugin ZIP must include {bootstrap}")
        bootstrap_data = zf.read(bootstrap)
        _assert_plugin_header(bootstrap_data, bootstrap)
        _assert_wpinc_guard(bootstrap_data, bootstrap)
        legacy = f"{PLUGIN_SLUG}/{PLUGIN_LEGACY_BOOTSTRAP}"
        if legacy in names:
            _assert_no_plugin_header(zf.read(legacy), legacy)
        impl = f"{PLUGIN_SLUG}/includes/connector.php"
        if impl not in names:
            raise ValueError(f"Plugin ZIP must include {impl}")


def build_plugin_zip_bytes() -> tuple[bytes, str]:
    """
    Archive layout (single top-level folder, no double-nesting)::

        riviso-content-operations/
            riviso-content-operations.php   <- Plugin Name header + WPINC guard
            includes/connector.php
            plugin.php                      <- legacy loader, no header
            index.php
            readme.txt
            uninstall.php
    """
    plugin_dir = resolve_plugin_source_dir()
    missing = [name for name in PLUGIN_BUNDLE_FILES if not (plugin_dir / name).is_file()]
    if missing:
        raise FileNotFoundError(
            f"Plugin bundle incomplete in {plugin_dir}: missing {', '.join(missing)}"
        )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name in PLUGIN_BUNDLE_FILES:
            data = _strip_utf8_bom((plugin_dir / name).read_bytes())
            if name.endswith(".php") or name.endswith(".txt"):
                data = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
            arc = _arcname_for(name)
            if name == PLUGIN_BOOTSTRAP:
                _assert_plugin_header(data, arc)
                _assert_wpinc_guard(data, arc)
            if name == PLUGIN_LEGACY_BOOTSTRAP:
                _assert_no_plugin_header(data, arc)
            info = zipfile.ZipInfo(arc)
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, data)

    out = buf.getvalue()
    validate_plugin_zip(out)
    return out, f"{PLUGIN_SLUG}.zip"

"""Build a WordPress-uploadable ZIP for the Riviso connector plugin."""

from __future__ import annotations

import io
import os
import zipfile
from pathlib import Path

PLUGIN_SLUG = "riviso-content-operations"
# Files shipped inside the plugin folder (order does not matter).
PLUGIN_BUNDLE_FILES = (
    f"{PLUGIN_SLUG}.php",
    "index.php",
    "readme.txt",
)


def resolve_plugin_source_dir() -> Path:
    """
    Locate ``backend/wordpress_plugin/riviso-content-operations`` from common
    repo and Docker layouts.
    """
    here = Path(__file__).resolve()
    roots = [
        here.parents[2],  # backend/
        here.parents[3],  # repo root (local)
        Path("/app"),
        Path("/app/backend"),
    ]
    candidates: list[Path] = []
    for root in roots:
        candidates.extend(
            [
                root / "wordpress_plugin" / PLUGIN_SLUG,
                root / "backend" / "wordpress_plugin" / PLUGIN_SLUG,
            ]
        )
    for path in candidates:
        main_php = path / f"{PLUGIN_SLUG}.php"
        if path.is_dir() and main_php.is_file():
            return path
    raise FileNotFoundError(
        "Riviso WordPress plugin source directory not found on server"
    )


def _arcname_for(rel_path: str) -> str:
    """WordPress requires forward slashes in ZIP entry names."""
    return f"{PLUGIN_SLUG}/{rel_path.replace(os.sep, '/')}"


def build_plugin_zip_bytes() -> tuple[bytes, str]:
    """
    Return ``(zip_bytes, download_filename)`` for the connector plugin.

    Archive layout (required by WordPress uploader)::

        riviso-content-operations/
            riviso-content-operations.php
            index.php
            readme.txt
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
            abs_path = plugin_dir / name
            data = abs_path.read_bytes()
            if name.endswith(".php") or name.endswith(".txt"):
                data = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
            info = zipfile.ZipInfo(_arcname_for(name))
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, data)

    return buf.getvalue(), f"{PLUGIN_SLUG}.zip"

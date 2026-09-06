#!/bin/bash
# Explicit user-local installation only. No root, no package manager, no
# compositor, theme, autostart or default-assistant changes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
DEST="$DATA/cosmos-linux"
LAUNCHER="$HOME/.local/bin/cosmos"
APP_ID="dk.andersmadsen.cosmos.linux"
ENTRY="$DATA/applications/$APP_ID.desktop"
LIBRARY="libcosmos_surface_client_ffi.so"
PYTHON="${PYTHON:-python3}"

if [[ ! -f "$ROOT/$LIBRARY" ]]; then
  echo "Missing $ROOT/$LIBRARY. Install from the archive that ./revival client build linux produced." >&2
  exit 1
fi
for path in "$DEST" "$LAUNCHER" "$ENTRY"; do
  if [[ -e "$path" ]]; then echo "Refusing to overwrite existing path: $path" >&2; exit 1; fi
done
if ! "$PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)'; then
  echo "Python 3.11 or newer is required (set PYTHON to a suitable interpreter)." >&2
  exit 1
fi

umask 022
mkdir -p "$DEST" "$HOME/.local/bin" "$DATA/applications"
cp -R "$ROOT/cosmos_linux" "$ROOT/requirements.txt" "$DEST/"
cp "$ROOT/$LIBRARY" "$DEST/$LIBRARY"
chmod 0644 "$DEST/$LIBRARY"
find "$DEST/cosmos_linux" -name '__pycache__' -type d -prune -exec rm -rf {} +

# The app runs from its own virtual environment; nothing is installed system-wide.
"$PYTHON" -m venv "$DEST/.venv"
"$DEST/.venv/bin/python" -m pip install --quiet --disable-pip-version-check --require-virtualenv \
  -r "$DEST/requirements.txt"

{
  printf '#!/bin/bash\nset -euo pipefail\nROOT=%q\n' "$DEST"
  cat <<'LAUNCH'
export PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}"
exec "$ROOT/.venv/bin/python" -m cosmos_linux "$@"
LAUNCH
} > "$LAUNCHER"
chmod +x "$LAUNCHER"

# Copy only Cosmos-named icons; never replace a whole theme directory.
for icon in "$ROOT"/icons/hicolor/*/apps/"$APP_ID"*; do
  size="$(basename "$(dirname "$(dirname "$icon")")")"
  mkdir -p "$DATA/icons/hicolor/$size/apps"
  cp "$icon" "$DATA/icons/hicolor/$size/apps/"
done

"$PYTHON" - "$ENTRY" "$LAUNCHER" "$APP_ID" <<'DESKTOP'
import sys
from pathlib import Path
entry, launcher, app_id = sys.argv[1:4]
command = launcher.replace('\\', '\\\\').replace('"', '\\"').replace('`', '\\`').replace('$', '\\$').replace('%', '%%')
Path(entry).write_text(
    '[Desktop Entry]\nType=Application\nName=Cosmos\nComment=Ask Cosmos from this computer\n'
    'Exec="' + command + '"\nIcon=' + app_id + '\nTerminal=false\nCategories=Utility;\n'
    'StartupNotify=true\nStartupWMClass=' + app_id + '\n')
DESKTOP

printf 'Installed Cosmos to %s\n' "$DEST"
printf 'Launch %q, or choose Cosmos in your launcher. Launching it again brings the window back.\n' "$LAUNCHER"
printf 'Optional Hyprland and Waybar examples: %s\n' "$ROOT/integration"

#!/bin/sh
# Remove a GitHub Desktop installation made by install.sh. Settings and
# repositories (in ~/.config/GitHub Desktop) are left untouched.
set -eu

prefix=${PREFIX:-"$HOME/.local"}
app_dir="$prefix/opt/github-desktop"

rm -f "$prefix/bin/github-desktop"
rm -f "$prefix/share/applications/github-desktop.desktop"
rm -f "$prefix/share/icons/hicolor/512x512/apps/github-desktop.png"
rm -rf "$app_dir"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$prefix/share/applications" || true
fi

echo "GitHub Desktop removed from $app_dir"

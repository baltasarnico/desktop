#!/bin/sh
# Install GitHub Desktop for the current user (no root required).
#
#   ./install.sh            installs into ~/.local
#   PREFIX=/some/dir ./install.sh
#
# Installs the app into $PREFIX/opt/github-desktop, a launcher command in
# $PREFIX/bin, a menu entry and icon, and registers the app as the handler
# for the links GitHub uses to open repositories and to finish signing in.
set -eu

source_dir=$(cd "$(dirname "$0")" && pwd)
prefix=${PREFIX:-"$HOME/.local"}
app_dir="$prefix/opt/github-desktop"
applications_dir="$prefix/share/applications"
icon_dir="$prefix/share/icons/hicolor/512x512/apps"
bin_dir="$prefix/bin"
desktop_file=github-desktop.desktop

if [ "$source_dir" != "$app_dir" ]; then
  mkdir -p "$prefix/opt"
  rm -rf "$app_dir.new"
  cp -a "$source_dir" "$app_dir.new"
  rm -rf "$app_dir"
  mv "$app_dir.new" "$app_dir"
fi

mkdir -p "$applications_dir" "$icon_dir" "$bin_dir"
sed "s|@EXEC@|\"$app_dir/desktop\"|" "$app_dir/github-desktop.desktop.in" \
  > "$applications_dir/$desktop_file"
cp "$app_dir/github-desktop.png" "$icon_dir/github-desktop.png"
ln -sf "$app_dir/desktop" "$bin_dir/github-desktop"

for scheme in x-github-client x-github-desktop-auth x-github-desktop-dev-auth; do
  # xdg-mime probes for tools of other desktops and complains when they're
  # missing, which is harmless.
  xdg-mime default "$desktop_file" "x-scheme-handler/$scheme" 2>/dev/null || true
done

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$applications_dir" || true
fi

echo "GitHub Desktop installed to $app_dir"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "Note: $bin_dir isn't on your PATH, the 'github-desktop' command won't be found." ;;
esac

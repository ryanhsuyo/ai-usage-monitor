#!/bin/bash
# Build the distributable universal (Intel + Apple Silicon) macOS bundle.
#
# Why this wrapper exists: `tauri build --target universal-apple-darwin` merges the two per-arch
# binaries with `lipo`, and that merge leaves the bundle without a usable signature —
# `codesign --verify` reports "code object is not signed at all" and `spctl` rejects it with
# "no usable signature". On Apple Silicon macOS refuses to execute an arm64 binary in that state,
# so the app cannot start at all: users report that it simply will not open. Re-signing ad-hoc
# after the merge restores a valid signature and the app launches.
#
# This does NOT replace Developer ID signing + notarization. The build stays ad-hoc, so a
# downloaded copy is still quarantined and the first launch needs the user to allow it in
# System Settings → Privacy & Security.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
BUNDLE_DIR="src-tauri/target/universal-apple-darwin/release/bundle"
APP="$BUNDLE_DIR/macos/AI Usage Monitor.app"

echo "==> building universal bundle"
pnpm tauri build --target universal-apple-darwin

echo "==> re-signing ad-hoc (lipo invalidates the signature)"
codesign --force --deep --sign - "$APP"

echo "==> verifying"
codesign --verify --deep --strict "$APP"
lipo -archs "$APP/Contents/MacOS/ai-usage-monitor"

# The .dmg produced by the build wraps the pre-signing app, so rebuild it from the signed bundle.
DMG="$BUNDLE_DIR/dmg/AI Usage Monitor_$(node -p "require('./package.json').version")_universal.dmg"
if [ -f "$DMG" ]; then
  echo "==> repackaging dmg from the signed app"
  rm -f "$DMG"
  STAGING="$(mktemp -d)"
  cp -R "$APP" "$STAGING/"
  ln -s /Applications "$STAGING/Applications"
  hdiutil create -volname "AI Usage Monitor" -srcfolder "$STAGING" -ov -format UDZO "$DMG" >/dev/null
  rm -rf "$STAGING"
fi

# Drop the finished build somewhere obvious rather than six levels down inside target/.
RELEASE_DIR="$HOME/Desktop/AI-Usage-Monitor-發佈"
mkdir -p "$RELEASE_DIR"
cp "$DMG" "$RELEASE_DIR/"
echo "==> done"
echo "    $DMG"
echo "    copied to: $RELEASE_DIR/$(basename "$DMG")"

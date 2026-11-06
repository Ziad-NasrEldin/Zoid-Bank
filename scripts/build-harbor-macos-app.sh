#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$PROJECT_DIR/.harbor/macos-build"
APP_DIR="$BUILD_DIR/Zoid Bank.app"
ICONSET_DIR="$BUILD_DIR/AppIcon.iconset"

npm --prefix "$PROJECT_DIR" run build >/dev/null
rm -rf "$ICONSET_DIR"
rm -rf "$APP_DIR"
mkdir -p "$BUILD_DIR" "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources" "$ICONSET_DIR"
swiftc -O -target arm64-apple-macosx13.0 \
  -parse-as-library \
  -framework SwiftUI \
  -framework WebKit \
  -framework AppKit \
  -framework Foundation \
  "$PROJECT_DIR/macos/HarborMacApp.swift" \
  -o "$APP_DIR/Contents/MacOS/ZoidBank"
swift "$PROJECT_DIR/scripts/generate-zoid-bank-app-icon.swift" "$ICONSET_DIR"
iconutil -c icns "$ICONSET_DIR" -o "$APP_DIR/Contents/Resources/AppIcon.icns"
rm -rf "$ICONSET_DIR"
cp "$PROJECT_DIR/macos/Info.plist" "$APP_DIR/Contents/Info.plist"
mkdir -p "$APP_DIR/Contents/Resources/dist"
cp -R "$PROJECT_DIR/dist/." "$APP_DIR/Contents/Resources/dist/"
codesign --force --deep --sign - "$APP_DIR"
echo "Built $APP_DIR"

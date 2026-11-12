#!/bin/sh
# Run gitleaks on the git history and on the working tree.
# Downloads a pinned release once into .cache/, and checks its SHA-256 on every run before it extracts it.
set -eu

VERSION=8.30.1
root=$(cd "$(dirname "$0")/.." && pwd)
archive="$root/.cache/gitleaks/gitleaks_${VERSION}.tar.gz"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=darwin_arm64 sha=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5 ;;
  Darwin-x86_64) platform=darwin_x64 sha=dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709 ;;
  Linux-aarch64 | Linux-arm64) platform=linux_arm64 sha=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;;
  Linux-x86_64) platform=linux_x64 sha=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
  *) echo "gitleaks.sh: no pinned gitleaks build for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

if [ ! -f "$archive" ]; then
  mkdir -p "$(dirname "$archive")"
  curl -fsSL -o "$archive.part" \
    "https://github.com/gitleaks/gitleaks/releases/download/v$VERSION/gitleaks_${VERSION}_$platform.tar.gz"
  mv "$archive.part" "$archive"
fi

# Check the archive on every run, not only after download, so a changed cache cannot run.
actual=$(sha256 "$archive")
if [ "$actual" != "$sha" ]; then
  rm -f "$archive"
  echo "gitleaks.sh: checksum mismatch for gitleaks $VERSION ($platform): got $actual; removed the cached archive" >&2
  exit 1
fi
bin_dir=$(mktemp -d)
trap 'rm -rf "$bin_dir"' EXIT
tar -xzf "$archive" -C "$bin_dir" gitleaks
bin="$bin_dir/gitleaks"

cd "$root"
"$bin" git --no-banner --redact --config .gitleaks.toml .
"$bin" dir --no-banner --redact --config .gitleaks.toml .

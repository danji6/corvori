# Build on a native Linux runner for each sidecar architecture.
let
  pkgs = import (builtins.fetchTarball
    "https://github.com/NixOS/nixpkgs/archive/0dc498bfe49baeb18b0f9891e800b53bb2603193.tar.gz") {};
  inherit (pkgs.pkgsStatic) bubblewrap ripgrep socat;
in pkgs.runCommand "corvori-linux-sandbox-helpers" {
  nativeBuildInputs = [ pkgs.binutils ];
} ''
  mkdir -p "$out/sources"
  install -m 755 ${bubblewrap}/bin/bwrap ${ripgrep}/bin/rg ${socat}/bin/socat "$out/"
  for executable in "$out/bwrap" "$out/rg" "$out/socat"; do
    if readelf -l "$executable" | grep -q INTERP || readelf -d "$executable" | grep -q NEEDED; then
      echo "Sandbox helpers must run without host libraries: $executable" >&2
      exit 1
    fi
  done
  tar -czf "$out/sources/bubblewrap-${bubblewrap.version}.tar.gz" -C ${dirOf (toString bubblewrap.src)} ${baseNameOf (toString bubblewrap.src)}
  tar -czf "$out/sources/ripgrep-${ripgrep.version}.tar.gz" -C ${dirOf (toString ripgrep.src)} ${baseNameOf (toString ripgrep.src)}
  tar -czf "$out/sources/socat-${socat.version}.tar.gz" -C ${dirOf (toString socat.src)} ${baseNameOf (toString socat.src)}
  cd "$out"
  sha256sum bwrap rg socat > SHA256SUMS
''

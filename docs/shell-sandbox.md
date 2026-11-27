# Native shell sandbox preview

The draft sidecar ships a diagnostic for the native command runner. Agent commands still use the existing approval flow. Run `bun scripts/sidecar.ts --check-sandbox` from the installation directory to build and exercise the diagnostic. It invokes the sidecar’s Node runtime against a disposable Git repository. A successful response names the selected backend. Restart the sidecar after an update.

## Release verification

The release workflow builds static `bwrap`, `socat`, and `rg` for Linux x64 and arm64. Both app archives include the binaries and upstream sources under `packages/sidecar/vendor/linux-<arch>`. The packager checks the three executable digests on each architecture. To package locally, place the two workflow artifacts’ `linux-<arch>.tar.gz` files in `.data/sandbox-helpers` before running `bun run package`. For a Linux source checkout, extract the matching artifact into `packages/sidecar/vendor/linux-<arch>` before running the diagnostic. A host that restricts user namespaces may require an administrator to permit the helper through its OS policy.

On Windows the diagnostic checks MXC first. The launcher supplies Node 24.22.3, which supports the MXC SDK’s native Windows streams. An unsupported MXC policy or host can use the packaged `srt-win` helper after an administrator runs `node node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js windows-install` from the installation directory. The diagnostic does not elevate or install the helper. On macOS it uses the system Seatbelt sandbox.

The native suite snapshots the workspace’s existing Git exclusions at each command launch. A command that was already running when a matching file appeared can retain its original view. An ordinary failure with no attributable denial provides no evidence about a blocked operation. The draft keeps the exit status and output available for diagnosis.

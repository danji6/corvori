# Native shell sandbox preview

The draft sidecar ships a diagnostic for the native command runner. Ordinary installations use the existing approval flow. Run `bun scripts/sidecar.ts --check-sandbox` from the installation directory to build and exercise the diagnostic. It invokes the sidecar’s Node runtime against a disposable Git repository. A successful response names the selected backend. Restart the sidecar after an update.

## Release verification

The release workflow builds static `bwrap`, `socat`, and `rg` for Linux x64 and arm64. Both app archives include the binaries and upstream sources under `packages/sidecar/vendor/linux-<arch>`. The packager checks the three executable digests on each architecture. To package locally, place the two workflow artifacts’ `linux-<arch>.tar.gz` files in `.data/sandbox-helpers` before running `bun run package`. For a Linux source checkout, extract the matching artifact into `packages/sidecar/vendor/linux-<arch>` before running the diagnostic. A host that restricts user namespaces may require an administrator to permit the helper through its OS policy.

On Windows the diagnostic checks MXC first. The launcher supplies Node 24.22.3, which supports the MXC SDK’s native Windows streams. An unsupported MXC policy or host can use the packaged `srt-win` helper after an administrator runs `node node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js windows-install` from the installation directory. The diagnostic does not elevate or install the helper. On macOS it uses the system Seatbelt sandbox.

The native suite snapshots the workspace’s existing Git exclusions at each command launch. A command that was already running when a matching file appeared can retain its original view. An ordinary failure preserves its exit status and output, including when the backend cannot identify a denied operation.

## One-time retry preview

On a Linux installation with the packaged helpers, or on macOS, set `CORVORI_SHELL_SANDBOX_PREVIEW=1` in the sidecar launch environment and restart it. Start a new chat for the updated shell tool definition. The preview applies to the agent’s normal-mode shell tool after its existing launch approval checks. Windows currently runs the packaged diagnostic and keeps the existing launch approvals. The pinned MXC backend rejects a request to disable filesystem restrictions while keeping the network fence. A Windows retry needs a backend that can honor the access shown in the approval.

A failed command returns to the agent. If it needs more access, it can request a retry by referencing the job number, repeating the original command and absolute working directory, selecting filesystem, network, or both, and explaining its reason. The approval shows what the agent requested. Approving starts the command over once. The original output stays in the chat. A sidecar restart, a change to the workspace revision, or a retry already spent invalidates the request. Successful commands finish normally, including those that handled a denied operation.

The preview runs ordinary shell commands offline with a fresh temporary home. A filesystem-only retry stays offline. A network-only retry keeps the filesystem policy. Direct CLI credential grants, automatic shell launches, and sandbox enforcement for the evaluator and workspace MCP are still pending.

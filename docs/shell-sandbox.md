# Native shell sandbox

The packaged sidecar checks that a native child can write in its workspace and cannot read a private sibling file. On Linux and macOS a successful check enables automatic sandboxed shell commands. Unconfigured hosts use the existing approval flow. Run `bun scripts/sidecar.ts --check-sandbox` from the installation directory to build and exercise the diagnostic. It invokes the sidecar’s Node runtime against a disposable Git repository. A successful response names the selected backend. Restart the sidecar after an update.

## Release verification

The release workflow builds static `bwrap`, `socat`, and `rg` for Linux x64 and arm64. Both app archives include the binaries and upstream sources under `packages/sidecar/vendor/linux-<arch>`. The packager checks the three executable digests on each architecture. To package locally, place the two workflow artifacts’ `linux-<arch>.tar.gz` files in `.data/sandbox-helpers` before running `bun run package`. For a Linux source checkout, extract the matching artifact into `packages/sidecar/vendor/linux-<arch>` before running the diagnostic. A host that restricts user namespaces may require an administrator to permit the helper through its OS policy.

On Windows the diagnostic checks MXC first. The launcher supplies Node 24.22.3, which supports the MXC SDK’s native Windows streams. An unsupported MXC policy or host can use the packaged `srt-win` helper after an administrator runs `node node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js windows-install` from the installation directory. The diagnostic does not elevate or install the helper. On macOS it uses the system Seatbelt sandbox.

The native suite snapshots the workspace’s existing Git exclusions at each command launch. A command that was already running when a matching file appeared can retain its original view. An ordinary failure preserves its exit status and output, including when the backend cannot identify a denied operation.

## Shell execution and retries

Restart the sidecar after installing the update and start a new chat. In normal mode, ordinary workspace scripts run offline with a private temporary home. A saved command prefix can give a direct `gh pr list` or `gh issue list` invocation network access and the GitHub account credential. Literal arguments such as `--repo danji6/corvori` pass directly to the CLI. Pipelines, substitutions, and interpreter calls start offline. Set `CORVORI_GH_BINARY` in the sidecar launch environment for a trusted CLI outside the standard installation paths.

Plan mode keeps its launch checks and a read-only workspace. Recognized direct Git inspections use a read-only metadata view. Evaluator and workspace MCP commands use the same filesystem and network policy. Explicit unrestricted shell mode retains host execution.

Windows uses its existing shell approval flow. The MXC backend rejects disabling filesystem restrictions while keeping the network fence. The Windows diagnostics exercise both MXC and the provisioned helper.

A failed command returns its output and exit status to the agent. On macOS, the result and retry approval can also show the operation and destination from a matching Seatbelt event. When the backend has no event for the job, the agent explains the access it needs. If it needs more access, it can request a retry by referencing the job number, repeating the original command and absolute working directory, selecting filesystem, network, or both, and explaining its reason. The approval shows what the agent requested. Approving starts the command over once. The original output stays in the chat. A sidecar restart, a change to the workspace revision, or a retry already spent invalidates the request. Successful commands finish normally, including those that handled a denied operation.

A filesystem-only retry preserves the original network policy. A network-only retry keeps filesystem restrictions.

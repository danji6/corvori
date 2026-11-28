# Native shell sandbox

The packaged sidecar checks that a native child can read an ordinary sibling file, write inside its workspace, and protect an ignored workspace file and outside writes. A successful check enables automatic sandboxed shell commands. Unconfigured hosts use the existing approval flow. Run `bun scripts/sidecar.ts --check-sandbox` from the installation directory to build and exercise the diagnostic. It invokes the sidecar’s Node runtime against a disposable Git repository. A successful response names the selected backend. Restart the sidecar after an update.

## Release verification

The release workflow builds static `bwrap`, `socat`, and `rg` for Linux x64 and arm64. Both app archives include the binaries and upstream sources under `packages/sidecar/vendor/linux-<arch>`. The packager checks the three executable digests on each architecture. To package locally, place the two workflow artifacts’ `linux-<arch>.tar.gz` files in `.data/sandbox-helpers` before running `bun run package`. For a Linux source checkout, extract the matching artifact into `packages/sidecar/vendor/linux-<arch>` before running the diagnostic. A host that restricts user namespaces may require an administrator to permit the helper through its OS policy.

On Windows the diagnostic checks MXC first. The launcher supplies Node 24.22.3, which supports the MXC SDK’s native Windows streams. An unsupported MXC policy or host can use the packaged `srt-win` helper after an administrator runs `node node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js windows-install` from the installation directory. The diagnostic does not elevate or install the helper. On macOS it uses the system Seatbelt sandbox.

The native suite snapshots the workspace’s existing Git exclusions at each command launch. A command that was already running when a matching file appeared can retain its original view. An ordinary failure preserves its exit status and output, including when the backend cannot identify a denied operation.

## Shell execution and retries

Restart the sidecar after installing the update and start a new chat. In normal mode, ordinary workspace scripts run offline with a private temporary home. A saved command prefix can give a direct `gh pr list` or `gh issue list` invocation network access and the GitHub account credential. Literal arguments such as `--repo danji6/corvori` pass directly to the CLI. Pipelines, substitutions, and interpreter calls start offline. Set `CORVORI_GH_BINARY` in the sidecar launch environment for a trusted CLI outside the standard installation paths.

Commands may read ordinary files outside the workspace, including files in other checkouts. Private Corvori storage, the GitHub CLI configuration, and existing Git-ignored workspace entries are hidden. An authorized session or agent can access its own files. Git metadata is readable. Writes stay within the authorized workspace, path grants, and private scratch directory.

Plan mode keeps its launch checks and a read-only workspace. Recognized direct Git inspections run with a read-only workspace. Evaluator and workspace MCP commands use the same filesystem and network policy. Explicit unrestricted shell mode retains host execution.

On compatible Windows 11 hosts, the packaged sidecar uses MXC after the same startup check. Other Windows hosts use the existing approval flow. The administrator-installed helper is available for diagnostics.

A failed command shows its output and exit status. If the agent needs more access, it requests a retry of that job and explains why. The approval card shows the command, working directory, reason, and requested access. On macOS it also shows the blocked operation and destination when Seatbelt identifies them. A successful command that handled a denied operation finishes normally.

**Run once outside the sandbox** restarts the command with the current user’s filesystem and network access. **Retry once with network** enables network access inside the filesystem sandbox. Either approval runs the original command from the beginning, so earlier work can happen again. The original output stays in the chat. Declining leaves the command stopped. A sidecar restart, a change to the workspace revision, or a retry already spent invalidates the request.

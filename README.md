# sbm

A small macOS command-line manager for [sing-box](https://github.com/SagerNet/sing-box), written in TypeScript and compiled with Bun native AOT. `sbm` exits after each command; launchd runs sing-box directly. Supports Apple Silicon and Intel Macs.

## Build and install the CLI

Install Bun through your preferred package manager, then:

```sh
bun install --frozen-lockfile
bun run setup:compiler
bun run typecheck
bun test
bun run build
sudo install -m 755 dist/sbm /usr/local/bin/sbm
```

The compiled executable does not require Bun on the target machine. Builds are native: build on arm64 for arm64 and on Intel for x64. The `/usr/local/bin` directory must already exist or be created before installing the CLI.

### Native AOT toolchain

Verified on 2026-11-02 with Homebrew Bun **1.4.4**, TypeScript **5.9.3**, and native AOT compiler **1.4.4-canary.1+3f3a9ff87** on macOS arm64. The stable Bun 1.4.4 executable did **not** expose the `bun compile` command documented at <https://bun.com/docs/compiler/aot>; merely passing `--aot` to its older build command did not establish AOT support.

`setup:compiler` downloads the current official Bun canary using the system curl with its default progress display, verifies the archive against GitHub's published SHA-256 digest, checks for native AOT support, and stores it in ignored `.tools/bun`. The exact revision, digest, and download URL are recorded in `.tools/compiler.json`. Canary changes over time; preserve that executable and metadata separately if you need to reproduce an exact compiler revision. Running setup again explicitly refreshes the compiler. Stable Bun remains installed globally.

`build` uses the local compiler when present and invokes `bun compile --trim`. It rejects a compiler without AOT support and never silently falls back to a bundled JavaScript runtime. Native AOT is experimental.

## Commands

```sh
sbm install                       # Install latest stable sing-box, without starting it
sbm install --version 1.14.4      # Select a specific version (including a downgrade)
sbm upgrade                      # Exact alias of install
sbm start --config /path/to/config.json
sbm start                        # Use the saved copy; already running is a successful no-op
sbm status                       # Version, PID/state, boot setting, config/log locations, cache folder and size
sbm pause                        # Stop now; preserve the boot setting
sbm enable                       # Enable boot startup; do not start now
sbm disable                      # Disable boot startup; do not pause now
```

Commands that access protected state request `sudo` when needed. For `install` and `upgrade`, release lookup, curl download, checksum verification, and executable-version verification happen as your normal user **before** requesting sudo. Progress messages identify each stage; curl uses its default progress display. Run these commands without a `sudo` prefix to keep downloads unprivileged. Cancelling the sudo prompt exits unsuccessfully without performing the requested operation. `--help` and `--version` require no privileges. Boot startup defaults to disabled. There is no `stop` or `logs` command.

`start` **never** installs or upgrades a core. Run `install` first. The first start requires `--config`; afterwards plain `start` uses the saved configuration. With `--config`, sbm validates an exact snapshot, saves it as `config.json`, and restarts a running instance. It always manages one instance. The source file remains untouched; later source edits require another `start --config`. Invalid configurations leave the running service unchanged. Failed startup restores the previous config and previous active state; a rollback failure is reported explicitly.

`pause` unloads the job so launchd cannot immediately restart it. An enabled boot service starts again after reboot; a disabled one stays paused. `enable` and `disable` only change the boot registration. To stay stopped across reboot, use both `pause` and `disable`.

`install` and `upgrade` look up the same official release through GitHub's API, download the native macOS archive using system curl with its default progress display, verify its published SHA-256 digest and reported core version, and check the saved configuration before replacing the core. Releases without a published SHA-256 digest are rejected. The same installed version leaves the service and installed files unchanged. Release metadata is checked each time, but a checksum-valid cached archive is reused without downloading the binary again. A running service is restarted after replacement; a paused service stays paused. Failed activation restores the previous binary and active state. Downloads and validation occur before pausing the old core. After sudo, installation rechecks a private snapshot of the archive and validates the saved configuration before replacing anything. Cancelling sudo removes the temporary handoff files and leaves managed state unchanged; the verified archive stays cached for the next attempt. Network/API rate-limit failures leave the installation unchanged. No GitHub token is required or read.

Concurrent mutating commands wait for a filesystem lock for up to 30 seconds. After an abrupt CLI termination, the error identifies the lock directory and its `pid` file; confirm no sbm operation is still running before removing a stale lock.

## Download cache

`sbm status` prints the invoking user's cache folder and its total regular-file size, including nested entries, in readable units and exact bytes. A missing cache reports `0 B`; symbolic links are not followed. The same user cache is reported when status elevates through sudo.

Verified core archives are kept in `~/Library/Caches/sbm/<release-and-architecture>/<sha256>.tar.gz`. Installation checks the release metadata, reuses a matching checksum-valid archive, verifies its executable version, then requests sudo to apply it. Missing or corrupt archives are downloaded using curl's default progress display. Cache entries are keyed by version, architecture, and published checksum so changed releases cannot reuse stale bytes. Partial downloads are never promoted to completed cache entries. The cache survives cancelled sudo requests and installation failures. Remove this directory to clear it; this does not affect the installed core or saved configuration.

## Configuration, assets, and logs

Managed data is stored under `/Library/Application Support/sbm/`:

| Path relative to that directory | Purpose |
| --- | --- |
| `bin/sing-box` | Official core executable |
| `bin/sing-box.previous` | Core predating the last replacement |
| `config.json` | Last successfully applied configuration |
| `config.json.previous` | Configuration predating the last replacement |
| `service.plist` | Runtime launchd definition |
| `logs/stdout.log`, `logs/stderr.log` | Captured service output |

The directory is root-owned and private; configurations, backups, and logs use mode `0600`. Read logs using the absolute paths printed by `sbm status`, for example `sudo tail -f '<stderr path>'`. If plain JSON sets `log.output`, status also reports that file. Service output files are appended and are not automatically rotated; manage their size as appropriate. Configuration contents are never printed by sbm, although core diagnostics can contain destination details.

The system service label is `io.github.chendesheng.sbm.sing-box`. Boot registration is `/Library/LaunchDaemons/io.github.chendesheng.sbm.sing-box.plist`. Sing-box runs as root for TUN support, with the managed directory as its working directory. Existing absolute paths are preserved. Relative asset/cache/log paths resolve against the managed directory, **not** the original configuration's directory. Copy required local rule sets, certificates, and other private assets there yourself, or use suitable absolute paths. Only the JSON is imported. Remote rule-set download/update behavior belongs to the supplied sing-box configuration; sbm does not rewrite routing or manage rule-set subscriptions.

[`examples/config.json`](examples/config.json) is a credential-free, loopback-only mixed proxy with direct outbound on port 19878. It is useful for checking service operation and does not configure a VPN or your private network. A valid configuration and stable process do not prove remote destinations, DNS, TUN routing, or private peers work.

Do not activate competing TUN configurations concurrently. sbm does not stop v2rayN, alter system-proxy settings, migrate identities, or change your VPS.

## Restore and rollback

Keep operational JSON, credentials, certificates, local assets, and any peer identities in your own private backup; they are absent from this repository. From a fresh clone, build/install the manager, install a compatible core, restore assets, then apply the backed-up JSON with `sbm start --config`. Enable boot startup separately if wanted. Reusing a device identity requires retiring its old active instance first.

For manual recovery, pause the service, run `sbm install --version <known-good-version>` if necessary, and apply the previous config with `sbm start --config '/Library/Application Support/sbm/config.json.previous'`. Copy that backup elsewhere first if you need to retain it, since applying it updates the previous-config backup. Keep configuration and asset versions compatible. Automatic rollback covers failed replacements, not power loss during a command or network failures after successful startup.

## Validation

```sh
bun test
bun run typecheck
bun run build
env -i PATH=/usr/bin:/bin ./dist/sbm --help
bun run smoke:launchd
```

Tests cover aliasing, missing-core startup, config replacement and rollback, install verification and rollback, boot settings, command idempotence, and concurrent operations. The opt-in smoke script downloads the official core, exercises the same lifecycle code in a disposable **user** launchd domain, and verifies actual SOCKS traffic to a loopback HTTP server. It removes its job and files afterwards. This is not a privileged system-domain, TUN, or reboot test.

The initial implementation passed that user-domain smoke test with sing-box 1.14.4. Privileged system-service activation, password-prompt cancellation, actual reboot persistence, Intel builds, and real TUN/private-network traffic still require separate runtime verification.

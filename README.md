# sbm

A small macOS manager for [sing-box](https://github.com/SagerNet/sing-box), with a CLI and native menu bar app, written in TypeScript and compiled to native code with [ScriptC](https://scriptc.dev). The CLI exits after each command; launchd runs sing-box directly. Supports Apple Silicon and Intel Macs.

## Build and install the CLI

Install Bun for dependency installation, builds and source tests, Node.js 24 or later for ScriptC's npm installer, and the Xcode Command Line Tools (`xcode-select --install`), then:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
mkdir -p "$HOME/.local/bin"
install -m 755 dist/sbm "$HOME/.local/bin/sbm"
```

The compiled executable requires neither Bun nor Node.js on the target machine. ScriptC links its own native support code, with no JavaScript engine. Builds use the host architecture: build on arm64 for arm64 and on Intel for x64. Add `~/.local/bin` to your `PATH` if necessary; installing the CLI there needs no sudo.

## Menu bar app

Set up the core and a saved configuration with the CLI first, then build and install the app in your user Applications folder:

```sh
bun run build:app
mkdir -p "$HOME/Applications"
ditto dist/sbm.app "$HOME/Applications/sbm.app"
open "$HOME/Applications/sbm.app"
```

The app requires macOS 14 or later and the same build dependencies as the CLI. It is locally ad-hoc signed. No Node.js, Bun, or separate JavaScript engine is needed to run it.

The menu bar uses a monochrome paper-plane app icon. The menu header shows the full-color app icon and a status label with a green dot for a running sing-box process, red for paused, or yellow while the state is unknown or launchd is waiting. This reports process state, not destination connectivity. The menu shows the installed sing-box version, one **Start/Pause** item, **Upgrade**, and **Quit sbm**. Status refreshes every five seconds and reflects CLI changes. Opening or quitting the app never starts or pauses sing-box.

Every menu opening checks the latest stable official release. The update item is disabled and shows **Checking…** until the response arrives, then shows disabled **No new version** for an equal or newer installed core, or **Upgrade to {version}** for an available update. A failed check shows disabled **Update check failed** and retries on the next opening. Start/Pause stays available during the check. Clicking the upgrade item installs the displayed release. During download the item is disabled and displays **Upgrading (42%)**, or a received byte count when the server gives no total size. It continues updating with the menu open, and opening the menu during an upgrade preserves its progress display. Checksum verification, executable-version verification, and saved-config validation finish before any administrator request. A paused core is replaced without elevation and stays paused. A running upgrade requests native macOS authorization only for activation/restart, with rollback on failure. Start/Pause also requests native authorization only when a service change is needed. Cancelling the password dialog leaves the operation unapplied. Operation errors use native alerts; no terminal is opened.

The AppKit menu is a small Objective-C bridge called through ScriptC's C FFI. A native `node:worker_threads` worker runs the shared TypeScript service, download, and install modules so AppKit's menu tracking loop cannot stall downloads. A bundled, short-lived `sbm-control` executable uses the same modules for authorized service changes. The app never invokes the sbm CLI and never migrates legacy storage automatically.

For a safe UI preview, run `dist/sbm.app/Contents/MacOS/sbm --demo`. It simulates status and upgrade progress without touching the service. `--ui-check` checks live progress during native menu tracking and exits automatically; `--worker-check` checks compiled worker/FFI startup without opening a menu.

### Native compiler

ScriptC **0.4.7** is pinned as a development dependency. Its required postinstall script is listed in Bun's `trustedDependencies`; it installs the compiler entry point from the platform-specific optional dependencies. Keep optional dependencies and install scripts enabled. `bun run build` runs the build driver with Bun, invokes the native compiler and writes `dist/sbm`. The driver uses Apple's system toolchain on macOS so an unrelated Clang installation cannot select a stale SDK. Set `SCRIPTC=/absolute/path/to/scriptc` to use a standalone compiler instead.

ScriptC is experimental. This port was verified on macOS arm64 with ScriptC **0.4.7** and TypeScript **5.9.3**. The runtime source uses Node APIs; Bun is used for build tooling, source development and unit tests.

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
sbm config route list [--priority]
sbm config route add --ip 192.0.2.1 --outbound direct
sbm config route add --domain example.com --outbound direct
sbm config route add --domain_suffix example.com --outbound direct
sbm config route remove --ip 192.0.2.1 --outbound direct
sbm config backup --file /path/to/sbm-backup.zip
sbm config restore --file /path/to/sbm-backup.zip
```

`status`, route listing/editing, and configuration backup run without sudo. The core and managed data belong to your user under `~/Library/Application Support/sbm/`. Installing or updating a paused core also needs no sudo; updating a running core requests authorization to restart the system service. A same-version install does not request authorization. Run commands without a `sudo` prefix so downloads remain unprivileged. Progress messages identify each stage; downloads use the shared streaming JavaScript downloader instead of a curl subprocess.

Starting or pausing the system service, changing boot registration, and restoring a backup still request sudo when needed. An already-running plain `start`, already-paused `pause`, and already-disabled `disable` return without elevation. Cancelling authorization leaves the requested operation unapplied. Boot startup defaults to disabled. There is no `stop` or `logs` command.

`start` **never** installs or upgrades a core. Run `install` first. The first start requires `--config`; afterwards plain `start` uses the saved configuration. With `--config`, sbm validates an exact snapshot, saves it as `config.json`, and restarts a running instance. It always manages one instance. The source file remains untouched; later source edits require another `start --config`. Invalid configurations leave the running service unchanged. Failed startup restores the previous config and previous active state; a rollback failure is reported explicitly.

`pause` unloads the job so launchd cannot immediately restart it. An enabled boot service starts again after reboot; a disabled one stays paused. `enable` and `disable` only change the boot registration. To stay stopped across reboot, use both `pause` and `disable`.

`install` and `upgrade` look up the same official release through GitHub's API, stream the native macOS archive using JavaScript fetch, verify its published SHA-256 digest and reported core version, and check the saved configuration before replacing the core. Downloads and redirects must use HTTPS, with timeouts and partial-file cleanup. Releases without a published SHA-256 digest are rejected. The same installed version leaves the service and installed files unchanged. Release metadata is checked each time, but a checksum-valid cached archive is reused without downloading the binary again. A running service is restarted after replacement; a paused service stays paused. Failed activation restores the previous binary and active state. Downloads and validation occur before pausing the old core. After sudo, installation rechecks a private snapshot of the archive and validates the saved configuration before replacing anything. Cancelling sudo removes the temporary handoff files and leaves managed state unchanged; the verified archive stays cached for the next attempt. Network/API rate-limit failures leave the installation unchanged. No GitHub token is required or read.

Concurrent mutating commands wait for a filesystem lock for up to 30 seconds. After an abrupt CLI termination, the error identifies the lock directory and its `pid` file; confirm no sbm operation is still running before removing a stale lock.

## Managed direct routes

`sbm config route` manages two sing-box source-format JSON files: `direct.json` and `direct-priority.json` under `~/Library/Application Support/sbm/`, without sudo. The applied sing-box configuration must define local rule sets referring to these files and route them to `direct` in the desired order. Provision both files and apply that configuration before using these commands; sbm does not automatically rewrite arbitrary routing configurations. Lists are independent: use `--priority` to select the high-priority file. The `--outbound` option currently accepts only `direct`.

`--domain` is an exact match, `--domain_suffix` matches the domain and subdomains, and `--ip` accepts an IP address or CIDR. Each add or remove takes exactly one match option. Addresses without a prefix become `/32` or `/128`. Duplicate additions are no-ops; removing a missing entry reports an error. Commands serialize changes and atomically replace the selected file with private permissions. sing-box reloads local rule sets when modified; no service restart is issued. A paused service uses the saved lists on its next start. Installing or applying the main configuration and its rule-set references is a separate operation.

## Download cache

`sbm status` runs without sudo and prints the invoking user's cache folder and its total regular-file size, including nested entries, in readable units and exact bytes. A missing cache reports `0 B`; symbolic links are not followed. An explicit `sudo sbm status` still reports the original user's cache. Service state remains available when private data belongs to another user or has not yet been migrated; inaccessible fields report unavailable.

Verified core archives are kept in `~/Library/Caches/sbm/<release-and-architecture>/<sha256>.tar.gz`. Installation checks the release metadata, reuses a matching checksum-valid archive, and verifies its executable version. Authorization is requested only when activation needs a service restart or a legacy storage migration. Missing or corrupt archives are streamed into exclusive private temporary files; the app receives incremental byte counts for progress. Cache entries are keyed by version, architecture, and published checksum so changed releases cannot reuse stale bytes. Partial downloads are never promoted to completed cache entries. The cache survives cancelled sudo requests and installation failures. Remove this directory to clear it; this does not affect the installed core or saved configuration.

## Configuration, assets, and logs

The core and managed data are stored under the service owner's `~/Library/Application Support/sbm/`:

| Path relative to that directory | Purpose |
| --- | --- |
| `bin/sing-box` | Official core executable |
| `bin/sing-box.previous` | Core predating the last replacement |
| `config.json` | Last successfully applied configuration |
| `config.json.previous` | Configuration predating the last replacement |
| `logs/stdout.log`, `logs/stderr.log` | Captured service output |

The directory is user-owned and private (`0700`); configurations, backups, and standard service logs use mode `0600`. Privileged operations return ownership of managed files to that user. Read the standard logs without sudo using the absolute paths printed by `sbm status`, for example `tail -f '<stderr path>'`. If plain JSON sets `log.output`, status also reports that file. Service output files are appended and are not automatically rotated; manage their size as appropriate. Configuration contents are never printed by sbm, although core diagnostics can contain destination details.

Only `service.plist` and `owner.json` remain under the root-owned `/Library/Application Support/sbm/`. The owner record identifies the one user and data directory associated with the system service; sudo resolves that same directory instead of switching to root's home. Other users can read basic service status, but configuration commands must run as the owner or root. The root service intentionally trusts that user's executable and configuration.

Existing installations migrate once when the next operation other than status needs the managed files. The migration requests administrator authorization, pauses a running service, moves its binary/config/assets/logs/cache into the user's Library, updates absolute paths under the old managed directory in the saved and previous JSON/JSONC configurations, updates service definitions, and resumes only a previously running service. Relative paths continue to resolve against the managed directory. Destination collisions fail before pausing; validation or startup failures attempt to restore the original files and service state. Status never triggers migration or requests sudo. No existing files at the destination are overwritten.

Migration interrupts sing-box while it moves the files. Authorize it with local access or an independent connection; a remote session that relies on sing-box can disconnect and may require manual reconnection.

The system service label is `io.github.chendesheng.sbm.sing-box`. Boot registration is `/Library/LaunchDaemons/io.github.chendesheng.sbm.sing-box.plist`. Sing-box runs as root for TUN support, with the managed directory as its working directory. Existing absolute paths are preserved. Relative asset/cache/log paths resolve against the managed directory, **not** the original configuration's directory. Copy required local rule sets, certificates, and other private assets there yourself, or use suitable absolute paths. Only the JSON is imported. Remote rule-set download/update behavior belongs to the supplied sing-box configuration; sbm does not rewrite routing or manage rule-set subscriptions.

[`examples/config.json`](examples/config.json) is a credential-free, loopback-only mixed proxy with direct outbound on port 19878. It is useful for checking service operation and does not configure a VPN or your private network. A valid configuration and stable process do not prove remote destinations, DNS, TUN routing, or private peers work.

Do not activate competing TUN configurations concurrently. sbm does not stop v2rayN, alter system-proxy settings, migrate identities, or change your VPS.

## Configuration backup and restore

`sbm config backup --file /path/to/backup.zip` creates one ZIP containing the saved configuration, its previous copy if present, managed route lists, other regular files under the managed directory, and the boot-startup setting. The ZIP contains credentials in plaintext and is created with mode `0600`; keep it somewhere private. An existing output file is not overwritten. The core binary, generated service definition, logs, download cache and default runtime `cache.db` are not included. Remote rule-set data can be downloaded again.

The backup checks local rule-set paths and TLS key/certificate path fields in the active plain-JSON configuration. Referenced files must exist under the service owner's `~/Library/Application Support/sbm/`; an external or missing referenced file causes backup to fail rather than silently producing an incomplete archive. Other types of external dependencies are not automatically discovered. Move required assets into the managed directory and update their paths before backing up. The core must be installed separately on the restore machine, and the restored configuration must be compatible with its version. Prefer relative asset references when moving backups between different user home directories.

`sbm config restore --file /path/to/backup.zip` validates archive members, file checksums and the configuration before completing. It restores the archived managed files and boot-startup setting, while retaining whether the service was running or paused. A running service is restarted once. Other existing files that are not in the archive are left in place. If validation or activation fails, sbm attempts to restore the prior files, boot setting and service state. Restore does not change the source file originally supplied to `sbm start --config`.

## Restore and rollback

Keep operational JSON, credentials, certificates, local assets, and any peer identities in your own private backup; they are absent from this repository. From a fresh clone, build/install the manager, install a compatible core, restore assets, then apply the backed-up JSON with `sbm start --config`. Enable boot startup separately if wanted. Reusing a device identity requires retiring its old active instance first.

For manual recovery, pause the service, run `sbm install --version <known-good-version>` if necessary, and apply the previous config with `sbm start --config "$HOME/Library/Application Support/sbm/config.json.previous"`. Copy that backup elsewhere first if you need to retain it, since applying it updates the previous-config backup. Keep configuration and asset versions compatible. Automatic rollback covers failed replacements, not power loss during a command or network failures after successful startup.

## Validation

```sh
bun test
bun run typecheck
bun run build
env -i PATH=/usr/bin:/bin ./dist/sbm --help
```

All tests live under `test/` and run together with `bun test`. The suite builds the CLI automatically and includes source and compiled tests. The native test covers CLI/self invocation, subprocess errors and timeouts, exclusive binary writes and permissions, routes, locks, backup ownership, restore, and rollback. ScriptC compiles the programs in `test/fixtures/`, and the test runner executes them with Bun and Node.js absent from `PATH`.

App tests cover paused/running updates, validation before authorization, cancellation, stale Start/Pause clicks, and version comparisons. Downloader tests cover binary streams, byte progress, redirects, size mismatches, cancellation, and cleanup. Compiled tests verify a real chunked network response with incremental progress, an official HTTPS core download into a disposable cache without activation, and the app's native worker/FFI startup with no Node or Bun on `PATH`.

The launchd test runs as part of the same suite. Run tests as your logged-in macOS user with Xcode Command Line Tools installed and network access to GitHub. It downloads or reuses the verified official core, exercises the same lifecycle code in a disposable **user** launchd domain, and verifies actual SOCKS traffic to a loopback HTTP server before and after moving the core and configuration to a user Library path. It removes its job and files afterwards. Source and compiled tests also cover migration rollback, path collisions, ownership records, unprivileged status, paused core updates, and cancellation before a running update. Privileged system-service activation, password-prompt cancellation, actual reboot persistence, Intel builds, and real TUN/private-network traffic still require separate runtime verification.

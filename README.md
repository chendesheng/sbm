# sbm

[![CI](https://github.com/chendesheng/sbm/actions/workflows/ci.yml/badge.svg)](https://github.com/chendesheng/sbm/actions/workflows/ci.yml)

A small manager for [sing-box](https://github.com/SagerNet/sing-box), with a CLI and a native macOS menu bar app, written in TypeScript and compiled to native code with [ScriptC](https://scriptc.dev). On macOS the CLI exits after each command and launchd runs sing-box directly; on Windows the CLI runs sing-box as an ordinary user process. Supports Apple Silicon Macs, plus a user-mode Windows x64 port in progress.

## Windows user mode

The Windows port deliberately avoids the Windows Service Control Manager, `ProgramData`, TUN, and elevation. sing-box runs with the invoking user's token, so sbm never needs an administrator password or a UAC prompt. A Windows sing-box configuration should therefore use proxy inbounds (such as `mixed`, `socks`, or `http`) rather than a TUN inbound, which still requires administrator rights.

Managed state lives under `%LOCALAPPDATA%\sbm`:

| Path | Purpose |
| --- | --- |
| `bin\sing-box.exe` | Official core executable |
| `config.json` | Last successfully applied configuration |
| `logs\stdout.log`, `logs\stderr.log` | Captured core output |
| `run.json` | PID and image name of the detached core |
| `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\sbm-sing-box.vbs` | Hidden sign-in launcher written by `enable` |

`install` selects the official `sing-box-<version>-windows-amd64.zip` release, verifies its published SHA-256 digest, and extracts `sing-box.exe` with the built-in `tar.exe`. `start` launches the core detached, records its PID, and keeps the CLI non-blocking. `pause` and `start` switch routing through the prepared Clash API exactly as on macOS, without restarting the core. `enable` writes a hidden `wscript` launcher to the user's Startup folder, so "boot startup" begins at sign-in; `disable` removes it. Updating a running core stops and restarts only the invoking user's process, without authorization.

The official archive also ships `libcronet.dll`; sbm currently installs only `sing-box.exe`. A configuration that uses the bundled cronet outbound must copy that DLL into `bin\` beside the core.

Not ported yet: configuration backup/restore (which still uses `zip`/`unzip`), the menu bar app, and administrator/TUN mode. Backup and restore fail with an explicit message on Windows; the other two are unavailable. Windows arm64 also runs through the x64 build, because ScriptC currently targets Windows x64 only.

To cross-compile the CLI from macOS or Linux, fetch ScriptC's Windows runtime pack and set the target. Linking uses zig, so it must be on `PATH`:

```sh
npm pack @scriptc/runtime-win32-x64-msvc@0.4.7
tar -xzf scriptc-runtime-win32-x64-msvc-0.4.7.tgz
SCRIPTC_TARGET=x86_64-windows-gnu SCRIPTC_RUNTIME_PACK="$PWD/package" \
  bun scripts/build.mjs src/cli.ts dist/sbm.exe
```

Windows release binaries are cross-compiled on macOS. ScriptC 0.4.7's native Windows compiler currently overflows its stack while compiling this codebase, so CI runs the Windows platform tests natively but builds the executable from macOS.

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

The compiled executable requires neither Bun nor Node.js on the target machine. ScriptC links its own native support code, with no JavaScript engine. Released macOS binaries target Apple Silicon. Add `~/.local/bin` to your `PATH` if necessary; installing the CLI there needs no sudo.

## CI and releases

CI typechecks, runs `bun run test:source`, builds the menu bar app and macOS CLI on arm64, cross-builds the Windows CLI from macOS, and runs the Windows platform tests natively.

Pushing a `v*` tag whose number matches `package.json` runs the release workflow. Keep the version printed by `sbm --version` in `src/cli.ts` in sync with `package.json`; the release build refuses a mismatch. It builds and publishes:

| Asset | Platform |
| --- | --- |
| `sbm-macos-arm64` | macOS 14 or later on Apple Silicon |
| `sbm-windows-x64.exe` | Windows 10/11 x64 |
| `SHA256SUMS` | SHA-256 checksums for both binaries |

The macOS binary is ad-hoc signed but not notarized, and the Windows binary is unsigned, so Gatekeeper or SmartScreen may ask for confirmation. The release contains the CLI only, not the macOS menu bar app.

```sh
# macOS Apple Silicon
curl -LO https://github.com/chendesheng/sbm/releases/latest/download/sbm-macos-arm64
chmod +x sbm-macos-arm64
xattr -d com.apple.quarantine sbm-macos-arm64 2>/dev/null || true
./sbm-macos-arm64 --version
```

On Windows, download `sbm-windows-x64.exe`, verify it against `SHA256SUMS`, and put it on `PATH`. The full `bun test` suite compiles the native fixtures as well; `bun run test:source` runs the faster source-only suite used by CI.

## Menu bar app

Set up the core and a saved configuration with the CLI first, then build and install the app in your user Applications folder:

```sh
bun run build:app
mkdir -p "$HOME/Applications"
ditto dist/sbm.app "$HOME/Applications/sbm.app"
open "$HOME/Applications/sbm.app"
```

The app requires macOS 14 or later and the same build dependencies as the CLI. It is locally ad-hoc signed. No Node.js, Bun, or separate JavaScript engine is needed to run it.

The menu bar uses a monochrome paper-plane app icon. The menu header shows the full-color app icon, the installed sing-box version beside the **sbm** title, and a status label with a green dot for normal routing, red for paused/direct routing (or a stopped core), or yellow while the state is unknown or launchd is waiting. This reports process and routing-mode state, not destination connectivity. The menu contains one **Start/Pause** item, the update status or upgrade action, a **VPS** group, and **Quit sbm**. Status refreshes every five seconds and reflects CLI changes. Opening or quitting the app never starts or pauses sing-box.

The **VPS** group is visible only while sing-box is running; VPS status polling also pauses when sing-box is not running. It has an **Exit** submenu with **DMIT direct**, **Japan**, and **Los Angeles**, plus a **WPS tunnel** switch. It uses the existing HTTP panel from `xray-setup` through the authenticated private Xray route. Requests use JavaScript `fetch`, just like release downloads, with no curl process or native HTTP bridge. When the managed DNS hosts configuration supplies an IPv4 address for `vps.internal`, sbm uses the existing numeric HTTP panel endpoint at that address on port 8787 to avoid system DNS failures; otherwise it uses `http://vps.internal`. The panel remains a VPS loopback service reached through Xray. HTTP controls use the selected endpoint's exact Origin and a fresh CSRF token; redirects and automatic control retries are disabled. GitHub downloads continue to use HTTPS. Opening the menu refreshes the service state first and then refreshes VPS status only if sing-box is running. Status refreshes on opening and every five seconds; unavailable controls are disabled. Exit changes are asynchronous: the checkmark follows the server's applied mode, and **Switching…** remains until the server finishes. DMIT direct retains the panel's OpenAI-via-Japan routing. The WPS switch updates locally as soon as you click and remains responsive while the server applies it. Requests run one at a time and coalesce to your latest selection; stale status responses cannot move the switch back. If the latest change fails, the switch returns to the last confirmed value and reports the failure. It controls both running state and boot startup, just like the panel, without a tooltip. These are VPS-wide settings shared by clients. Each user action fetches a fresh CSRF token and sends the panel's required origin; failed control requests are never automatically retried.

Every menu opening checks the latest stable official release in the background. The update item stays hidden during the check and appears as **Upgrade to {version}** only when a newer version is available. It stays hidden when the installed core is up to date or the check fails; failed checks retry on the next opening. Start/Pause stays available during the check. Clicking the upgrade item installs the displayed release. During download the item is disabled and displays **Upgrading (42%)**, or a received byte count when the server gives no total size. It continues updating with the menu open, and opening the menu during an upgrade preserves its progress display. Checksum verification, executable-version verification, and saved-config validation finish before any administrator request. A stopped core is replaced without elevation and stays stopped. A core paused in direct mode is still running, so upgrades require authorization and retain direct mode. A running upgrade requests native macOS authorization only for activation/restart, with rollback on failure. Pause/Start switches routing through the local Clash API without authorization once routing pause is configured. Initial setup and starting a stopped service still require native authorization. Cancelling the password dialog leaves the operation unapplied. Operation errors use native alerts; no terminal is opened.

The AppKit menu is a small Objective-C bridge called through ScriptC's C FFI. A native `node:worker_threads` worker runs the shared TypeScript service, download, and install modules so AppKit's menu tracking loop cannot stall downloads. A bundled, short-lived `sbm-control` executable uses the same modules for authorized service changes. The app never invokes the sbm CLI and never migrates legacy storage automatically.

For a safe UI preview, run `dist/sbm.app/Contents/MacOS/sbm --demo`. It simulates status, upgrade progress, all three exits, and the WPS switch without touching local or VPS services. `--ui-check` checks progress and VPS controls during native menu tracking and exits automatically; `--worker-check` checks compiled worker/FFI startup without opening a menu.

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
sbm pause                        # Direct traffic and DNS; keep the core running
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

`status`, route listing/editing, and configuration backup run without sudo. The core and managed data belong to your user under `~/Library/Application Support/sbm/`. Installing or updating a stopped core also needs no sudo; updating a running core requests authorization to restart the system service. A same-version install does not request authorization. Run commands without a `sudo` prefix so downloads remain unprivileged. Progress messages identify each stage; downloads use the shared streaming JavaScript downloader instead of a curl subprocess.

Starting a stopped system service, setting up routing pause for the first time, changing boot registration, and restoring a backup still request sudo when needed. After setup, `pause` and an already-running plain `start` switch routing without elevation. An already-stopped `pause` and already-disabled `disable` return without elevation. Cancelling authorization leaves the requested operation unapplied. Boot startup defaults to disabled. There is no `stop` or `logs` command.

`start` **never** installs or upgrades a core. Run `install` first. The first start requires `--config`; afterwards plain `start` uses the saved configuration. With `--config`, sbm validates an exact snapshot, saves it as `config.json`, and restarts a running instance. It always manages one instance. The source file remains untouched; later source edits require another `start --config`. Invalid configurations leave the running service unchanged. Failed startup restores the previous config and previous active state; a rollback failure is reported explicitly.

`pause` keeps sing-box and its TUN interface running and selects a dedicated direct routing mode. It overrides existing traffic and DNS rules, preserves records from configured `hosts` DNS servers, uses the system's local DNS resolver for other names, and closes existing connections so clients reconnect through the direct route. Preserving host records prevents known private names from acquiring a negative DNS cache during Pause; it does not make proxy-only destinations reachable while paused. `start` restores the previous routing mode and closes connections again; it does not restart a running core.

Configurations prepared by an older sbm need one authorized restart on the next Pause to add host-record preservation. Start can still resume the older configuration without authorization. The change prevents new negative answers for configured host records; it does not remove failures already cached by the operating system or browser, or preserve names available only from private upstream DNS.

To keep a private zone using its authoritative server during Pause, place an explicit DNS rule **before** the managed `sbm-direct` DNS block in the prepared configuration, then apply it with `start --config`. For example, `{ "domain_suffix": ["devices.example"], "action": "route", "server": "private-dns" }` keeps the device inventory on that DNS server. The resolver must have a working transport during Pause (such as an explicit `detour` through an existing tunnel). This is a DNS exception: other DNS queries and application traffic still follow Pause's direct policy. sbm preserves these preceding DNS rules during later setup upgrades; no device-name/IP list is copied into the client.

The first Pause prepares the saved JSON configuration and restarts the service once with administrator authorization. Setup adds highest-priority mode rules, a direct outbound with a local DNS resolver, and a loopback-only Clash API protected by a secret. Existing controller addresses must bind to `127.0.0.1` or `::1`; an existing secret is preserved. The previous configuration is retained in `config.json.previous`. Later Pause/Start operations use the API with a timeout, verify the applied mode, and never fall back to stopping the service when the API fails. Importing a different configuration may require setup again. JSONC configurations must first be converted to JSON to enable routing pause.

`enable` and `disable` only change boot registration. Pause no longer disables a running service: a routing-paused core still needs authorization for upgrades. Across a reboot, the mode follows sing-box's configured mode-cache behavior; use `start` to return to normal routing. With boot startup disabled, the service will not start on reboot.

`install` and `upgrade` look up the same official release through GitHub's API, stream the native macOS archive using JavaScript fetch, verify its published SHA-256 digest and reported core version, and check the saved configuration before replacing the core. Downloads and redirects must use HTTPS, with timeouts and partial-file cleanup. Releases without a published SHA-256 digest are rejected. The same installed version leaves the service and installed files unchanged. Release metadata is checked each time, but a checksum-valid cached archive is reused without downloading the binary again. A running service is restarted after replacement; a stopped service stays stopped, and direct routing mode is retained across a running upgrade. Failed activation restores the previous binary and active state. Downloads and validation occur before stopping the old core. After sudo, installation rechecks a private snapshot of the archive and validates the saved configuration before replacing anything. Cancelling sudo removes the temporary handoff files and leaves managed state unchanged; the verified archive stays cached for the next attempt. Network/API rate-limit failures leave the installation unchanged. No GitHub token is required or read.

Concurrent mutating commands wait for a filesystem lock for up to 30 seconds. After an abrupt CLI termination, the error identifies the lock directory and its `pid` file; confirm no sbm operation is still running before removing a stale lock.

## Managed direct routes

`sbm config route` manages two sing-box source-format JSON files: `direct.json` and `direct-priority.json` under `~/Library/Application Support/sbm/`, without sudo. The applied sing-box configuration must define local rule sets referring to these files and route them to `direct` in the desired order. Provision both files and apply that configuration before using these commands; sbm does not automatically rewrite arbitrary routing configurations. Lists are independent: use `--priority` to select the high-priority file. The `--outbound` option currently accepts only `direct`.

`--domain` is an exact match, `--domain_suffix` matches the domain and subdomains, and `--ip` accepts an IP address or CIDR. Each add or remove takes exactly one match option. Addresses without a prefix become `/32` or `/128`. Duplicate additions are no-ops; removing a missing entry reports an error. Commands serialize changes and atomically replace the selected file with private permissions. sing-box reloads local rule sets when modified; no service restart is issued. While routing is paused, the direct override takes precedence over these lists; Start restores their normal use. Installing or applying the main configuration and its rule-set references is a separate operation.

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

The system service label is `io.github.chendesheng.sbm.sing-box`. Boot registration is `/Library/LaunchDaemons/io.github.chendesheng.sbm.sing-box.plist`. Sing-box runs as root for TUN support, with the managed directory as its working directory. Existing absolute paths are preserved. Relative asset/cache/log paths resolve against the managed directory, **not** the original configuration's directory. Copy required local rule sets, certificates, and other private assets there yourself, or use suitable absolute paths. Only the JSON is imported. Remote rule-set download/update behavior belongs to the supplied sing-box configuration; sbm adds its dedicated routing-pause rules during setup but does not manage rule-set subscriptions.

[`examples/config.json`](examples/config.json) is a credential-free, loopback-only mixed proxy with direct outbound on port 19878. It is useful for checking service operation and does not configure a VPN or your private network. A valid configuration and stable process do not prove remote destinations, DNS, TUN routing, or private peers work.

Do not activate competing TUN configurations concurrently. sbm does not stop v2rayN, alter system-proxy settings, or migrate identities. Only explicit actions in the menu's VPS group change the remote exit or WPS tunnel.

## Configuration backup and restore

`sbm config backup --file /path/to/backup.zip` creates one ZIP containing the saved configuration, its previous copy if present, managed route lists, other regular files under the managed directory, and the boot-startup setting. The ZIP contains credentials in plaintext and is created with mode `0600`; keep it somewhere private. An existing output file is not overwritten. The core binary, generated service definition, logs, download cache and default runtime `cache.db` are not included. Remote rule-set data can be downloaded again.

The backup checks local rule-set paths and TLS key/certificate path fields in the active plain-JSON configuration. Referenced files must exist under the service owner's `~/Library/Application Support/sbm/`; an external or missing referenced file causes backup to fail rather than silently producing an incomplete archive. Other types of external dependencies are not automatically discovered. Move required assets into the managed directory and update their paths before backing up. The core must be installed separately on the restore machine, and the restored configuration must be compatible with its version. Prefer relative asset references when moving backups between different user home directories.

`sbm config restore --file /path/to/backup.zip` validates archive members, file checksums and the configuration before completing. It restores the archived managed files and boot-startup setting, while retaining whether the core was running or stopped and preserving direct routing if it was paused. A running service is restarted once. Other existing files that are not in the archive are left in place. If validation or activation fails, sbm attempts to restore the prior files, boot setting and service state. Restore does not change the source file originally supplied to `sbm start --config`.

## Restore and rollback

Keep operational JSON, credentials, certificates, local assets, and any peer identities in your own private backup; they are absent from this repository. From a fresh clone, build/install the manager, install a compatible core, restore assets, then apply the backed-up JSON with `sbm start --config`. Enable boot startup separately if wanted. Reusing a device identity requires retiring its old active instance first.

For manual recovery, run `sbm install --version <known-good-version>` if necessary, and apply the previous config with `sbm start --config "$HOME/Library/Application Support/sbm/config.json.previous"`. Copy that backup elsewhere first if you need to retain it, since applying it updates the previous-config backup. Keep configuration and asset versions compatible. Automatic rollback covers failed replacements, not power loss during a command or network failures after successful startup.

## Validation

```sh
bun test
bun run typecheck
bun run build
env -i PATH=/usr/bin:/bin ./dist/sbm --help
```

All tests live under `test/` and run together with `bun test`. The suite builds the CLI automatically and includes source and compiled tests. The native test covers CLI/self invocation, subprocess errors and timeouts, exclusive binary writes and permissions, routes, locks, backup ownership, restore, and rollback. ScriptC compiles the programs in `test/fixtures/`, and the test runner executes them with Bun and Node.js absent from `PATH`.

App tests cover stopped/running updates, password-free routing Pause/Start, validation before authorization, cancellation, stale Start/Pause clicks, and version comparisons. Downloader tests cover binary streams, byte progress, redirects, size mismatches, cancellation, and cleanup. Compiled tests verify a real chunked network response with incremental progress, an official HTTPS core download into a disposable cache without activation, and the app's native worker/FFI startup with no Node or Bun on `PATH`.

The launchd test runs as part of the same suite. Run tests as your logged-in macOS user with Xcode Command Line Tools installed and network access to GitHub. It downloads or reuses the verified official core, exercises the same lifecycle code in a disposable **user** launchd domain, and verifies actual SOCKS traffic to a loopback HTTP server before and after moving the core and configuration to a user Library path. It removes its job and files afterwards. Source and compiled tests also cover migration rollback, path collisions, ownership records, unprivileged status, paused core updates, and cancellation before a running update. Privileged system-service activation, password-prompt cancellation, actual reboot persistence, and real TUN/private-network traffic still require separate runtime verification.

The routing fixture uses `SBM_TEST_CORE` (or the installed user core) in a disposable directory with loopback listeners. It verifies TCP by IP and hostname plus UDP DNS: normal rules reject/refuse, Pause succeeds directly, and Start restores the original behavior without changing the core PID. It does not alter the active service or TUN routing.

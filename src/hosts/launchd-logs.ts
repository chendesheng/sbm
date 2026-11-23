const logLimit = 20 * 1024 * 1024;

// launchd opens the service logs in append mode. Snapshot and truncate the same
// inode so the running core can continue using the file descriptors it inherited.
const rotateLogs = `
umask 077

rotate_log() {
    log=$1
    latest="$log.1.gz"
    pending="$latest.pending"
    [ -f "$log" ] && [ ! -L "$log" ] || return 0

    if [ ! -f "$pending" ]; then
        info=$(/usr/bin/stat -f '%d:%i %z' "$log") || return 1
        [ "\${info##* }" -ge ${logLimit} ] || return 0
        /bin/cp -c "$log" "$pending.new" && /bin/mv -f "$pending.new" "$pending" || return 1
        current=$(/usr/bin/stat -f '%d:%i' "$log") || return 1
        if [ "$current" = "\${info% *}" ]; then
            : > "$log" || return 1
        fi
    fi

    /usr/bin/gzip -n -1 -c "$pending" > "$latest.tmp" || return 1
    if [ -f "$latest" ]; then
        /bin/mv -f "$latest" "$log.2.gz" || return 1
    fi
    /bin/mv -f "$latest.tmp" "$latest" && /bin/rm "$pending"
}

for stream do
    rotate_log "$stream" || /usr/bin/logger -t sbm "Could not rotate $stream"
done
`;

// exec keeps the launchd job PID equal to the core PID. launchd cleans up the
// rotation loop with the rest of the job's process group when the core exits.
const launchCore = `
core_pid=$$
rotate=$1
stdout=$2
stderr=$3
shift 3
(
    uid=$(/usr/bin/id -u) || exit 1
    while kill -0 "$core_pid" 2>/dev/null; do
        owner=$(/usr/bin/stat -f '%u' .) || exit 1
        if [ "$uid" = 0 ] && [ "$owner" != 0 ]; then
            /usr/bin/sudo -n -u "#$owner" -- /bin/sh -c "$rotate" sbm-log-rotation "$stdout" "$stderr"
        else
            /bin/sh -c "$rotate" sbm-log-rotation "$stdout" "$stderr"
        fi
        /bin/sleep 60
    done
) </dev/null >/dev/null 2>&1 &
exec "$@"
`;

export function launchdLogArguments(stdout: string, stderr: string, command: string[]): string[] {
  return ['/bin/sh', '-c', launchCore, 'sbm', rotateLogs, stdout, stderr, ...command];
}

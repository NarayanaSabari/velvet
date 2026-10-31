# Arguments: parent PID, private same-volume transaction directory, app, relaunch.
# Keep the journal and original bundle on every failure, including failed rollback.
transaction=$2
target=$3
next="$transaction/next.app"
old="$transaction/previous.app"
message='Update helper was interrupted.'
installed=0
finish() {
    code=$?
    trap - EXIT HUP INT TERM
    if [ "$code" -ne 0 ]; then
        if [ "$installed" = 0 ] && [ -d "$old" ]; then
            if [ ! -e "$target" ] && [ ! -L "$target" ] && mv "$old" "$target"; then
                message="$message The previous app was restored."
            else
                message="$message Restore the previous app from $old."
            fi
        fi
        printf '%s' "$target" > "$transaction/target"
        printf '%s\n' "$message" > "$transaction/status"
        printf '%s\n' "$message" >&2
    fi
    exit "$code"
}
trap finish EXIT
trap 'exit 1' HUP INT TERM
message='Update could not start because its prepared app or installed app is missing.'
[ -d "$next" ] && [ -d "$target" ] || exit 1
message='Update helper could not record readiness.'
printf 'Update was interrupted before completion.\n' > "$transaction/status" || exit 1
: > "$transaction/ready" || exit 1
while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
message='Update could not preserve the installed app.'
mv "$target" "$old" || exit 1
message='Update could not install the prepared app.'
[ ! -e "$target" ] && [ ! -L "$target" ] || exit 1
mv "$next" "$target" || exit 1
installed=1
if [ "$4" = 1 ]; then
    message='Update installed, but Velvet could not relaunch. Open it manually.'
    # Clear the pending status before open can start the next app process.
    rm "$transaction/status" || exit 1
    open "$target" || exit 1
fi
message='Update installed, but the previous app could not be removed.'
rm -rf "$old" || exit 1
message='Update installed, but its recovery files could not be removed.'
rm -rf "$transaction" || exit 1
exit 0

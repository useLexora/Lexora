#!/usr/bin/env bash
set -euo pipefail

apk=${1:?Expected signed APK path}
application_id=${2:?Expected application ID}
sdk=${ANDROID_HOME:?Android SDK is required}
device=emulator-5554
adb=("$sdk/platform-tools/adb" -s "$device")
avd_home=$(mktemp -d)
export ANDROID_AVD_HOME="$avd_home"

cleanup() {
  local status=$?
  if (( status != 0 )); then
    tail -n 80 "$avd_home/emulator.log" 2>/dev/null || true
    timeout 10 "${adb[@]}" logcat -b crash -d || true
  fi
  if [[ -n "${emulator_pid:-}" ]]; then
    kill "$emulator_pid" 2>/dev/null || true
    wait "$emulator_pid" 2>/dev/null || true
  fi
  rm -rf "$avd_home"
}
trap cleanup EXIT

avdmanager create avd --name lexora-release --package 'system-images;android-36;google_apis;x86_64' <<< 'no'
"$sdk/platform-tools/adb" start-server
"$sdk/emulator/emulator" -avd lexora-release -port 5554 -no-window -no-audio -no-snapshot -no-boot-anim -gpu swiftshader_indirect -accel on > "$avd_home/emulator.log" 2>&1 &
emulator_pid=$!

timeout 180 "${adb[@]}" wait-for-device
timeout 180 bash -c 'until [[ $("$@" shell getprop sys.boot_completed) == 1 ]]; do sleep 2; done' _ "${adb[@]}"
"${adb[@]}" shell input keyevent KEYCODE_WAKEUP
"${adb[@]}" shell wm dismiss-keyguard
timeout 120 "${adb[@]}" install "$apk"
launch=$(timeout 60 "${adb[@]}" shell am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p "$application_id")
printf '%s\n' "$launch"
grep -Fx 'Status: ok' <<< "$launch"
"${adb[@]}" shell pidof "$application_id"
activity=$("${adb[@]}" shell dumpsys activity activities)
grep -F 'topResumedActivity=' <<< "$activity" | grep -F " $application_id/"

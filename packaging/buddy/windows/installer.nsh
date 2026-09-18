!define /redef APP_FILENAME "${PRODUCT_FILENAME}"

!macro customHeader
  !ifdef BUILD_UNINSTALLER
    Function un.BuddyCheckAppRunning
  !else
    Function BuddyCheckAppRunning
  !endif
    Push $0
    Push $1
    Push $2
    InitPluginsDir
    ClearErrors
    File /oname=$PLUGINSDIR\buddy-process-control.exe "$%LEXORA_INSTALLER_PROCESS_HELPER%"
    IfErrors buddy_probe_failed

    buddy_retry:
      DetailPrint "正在检查应用状态 / Checking application state..."
      nsExec::ExecToStack /TIMEOUT=30000 '"$PLUGINSDIR\buddy-process-control.exe" --check-running "$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
      Pop $0
      Pop $1
      DetailPrint "Process check: $0 $1"
      ClearErrors
      FileOpen $2 "$TEMP\Lexora-Buddy-installer.log" a
      IfErrors buddy_probe_logged
      FileWrite $2 "$INSTDIR\${APP_EXECUTABLE_FILENAME}: $0 $1$\r$\n"
      FileClose $2
    buddy_probe_logged:
      StrCmp $0 "0" buddy_ready
      StrCmp $0 "32" buddy_running
      StrCmp $0 "timeout" buddy_probe_timeout

    buddy_probe_failed:
      SetErrorLevel 1603
      StrCpy $1 "无法确认此安装中的 Buddy 是否已退出，操作已停止。请检查系统状态后重试，或取消。$\r$\n$\r$\nUnable to check whether this installation is running. Retry after checking your system, or cancel."
      Goto buddy_blocked

    buddy_probe_timeout:
      SetErrorLevel 1460
      StrCpy $1 "检查 Buddy 运行状态超时，操作已停止。请重试，或取消。$\r$\n$\r$\nChecking whether Buddy is running timed out. Retry or cancel."
      Goto buddy_blocked

    buddy_running:
      SetErrorLevel 32
      StrCpy $1 "此安装中的 Buddy 仍在运行。请从系统托盘选择退出，等待退出完成后重试，或取消。安装器不会终止应用。$\r$\n$\r$\nBuddy is still running from this installation. Quit from the system tray, then retry, or cancel. The installer will not terminate the app."

    buddy_blocked:
      IfSilent 0 +2
      Quit
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$1" IDRETRY buddy_retry
      SetErrorLevel 1602
      Quit

    buddy_ready:
      SetErrorLevel 0
      Pop $2
      Pop $1
      Pop $0
    FunctionEnd
!macroend

!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    Call un.BuddyCheckAppRunning
  !else
    Call BuddyCheckAppRunning
  !endif
!macroend

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

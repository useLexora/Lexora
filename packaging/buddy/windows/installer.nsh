!define /redef APP_FILENAME "${PRODUCT_FILENAME}"

Var /GLOBAL BuddyInstallMutex

!macro customHeader
  !ifdef BUILD_UNINSTALLER
    Function un.BuddyCheckAppRunning
  !else
    Function BuddyCheckAppRunning
  !endif
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    InitPluginsDir
    ClearErrors
    File /oname=$PLUGINSDIR\buddy-process-control.exe "$%LEXORA_INSTALLER_PROCESS_HELPER%"
    IfErrors buddy_probe_failed

    StrCpy $3 0
    StrCpy $4 0

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
      ${If} $3 > 0
        IntOp $3 $3 - 1
        Sleep 1000
        Goto buddy_retry
      ${EndIf}
      SetErrorLevel 32
      StrCmp $4 "1" buddy_manual_exit
      ${If} ${isUpdated}
        StrCpy $4 1
        StrCpy $3 30
        Goto buddy_wait_updated
      ${EndIf}
      IfSilent buddy_blocked
      MessageBox MB_YESNOCANCEL|MB_ICONQUESTION "安装需要退出此安装中的 Lexora。选择是以关闭应用并继续，选择否后从托盘手动退出，或取消安装。$\r$\n$\r$\nLexora must exit before installation can continue. Choose Yes to close it and continue, No to quit manually from the tray, or Cancel." IDYES buddy_request_exit IDNO buddy_manual_exit
      SetErrorLevel 1602
      Quit

    buddy_request_exit:
      StrCpy $4 1
      Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit-for-install --background'
      StrCpy $3 30
    buddy_wait_updated:
      Sleep 1000
      Goto buddy_retry

    buddy_manual_exit:
      StrCpy $4 0
      StrCpy $1 "Lexora 仍在运行，或退出已取消。旧版本需从托盘退出后重试。$\r$\n$\r$\nLexora is still running, or closing was cancelled. Older versions must be closed from the system tray. Retry after it exits."

    buddy_blocked:
      IfSilent 0 +2
      Quit
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$1" IDRETRY buddy_retry
      SetErrorLevel 1602
      Quit

    buddy_ready:
      SetErrorLevel 0
      Pop $4
      Pop $3
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

!macro BuddyAcquireInstallationMutex
  System::Call 'kernel32::CreateMutex(p 0, i 1, t "Local\lexora-buddy-installation") p.r0'
  StrCpy $BuddyInstallMutex $0
  StrCmp $BuddyInstallMutex "0" 0 +3
    SetErrorLevel 1603
    Abort
!macroend

!macro customInit
  !insertmacro BuddyAcquireInstallationMutex
!macroend

!macro customUnInit
  !insertmacro BuddyAcquireInstallationMutex
!macroend

!macro customInstall
  System::Call 'kernel32::ReleaseMutex(p $BuddyInstallMutex)'
  System::Call 'kernel32::CloseHandle(p $BuddyInstallMutex)'
  ${If} ${Silent}
  ${AndIf} ${isUpdated}
    Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --updated'
  ${EndIf}
!macroend

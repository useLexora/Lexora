!define /redef APP_FILENAME "${PRODUCT_FILENAME}"

Var /GLOBAL BuddyInstallMutex

!include "FileFunc.nsh"
!include "WordFunc.nsh"

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
      StrCmp $0 "0" buddy_check_core
      StrCmp $0 "32" buddy_running
      StrCmp $0 "timeout" buddy_probe_timeout

      Goto buddy_probe_failed

    buddy_check_core:
      IfFileExists "$INSTDIR\resources\lexora-runtime\node.exe" 0 buddy_ready
      nsExec::ExecToStack /TIMEOUT=30000 '"$PLUGINSDIR\buddy-process-control.exe" --check-running "$INSTDIR\resources\lexora-runtime\node.exe"'
      Pop $0
      Pop $1
      DetailPrint "Core process check: $0 $1"
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
      ClearErrors
      ${GetFileVersion} "$INSTDIR\${APP_EXECUTABLE_FILENAME}" $0
      IfErrors buddy_manual_exit
      ${VersionCompare} "$0" "0.11.1.0" $1
      StrCmp $1 "2" buddy_manual_exit
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
      UserInfo::GetAccountType
      Pop $0
      StrCmp $0 "User" 0 buddy_manual_exit
      StrCpy $4 1
      Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit-for-install --background'
      StrCpy $3 30
    buddy_wait_updated:
      Sleep 1000
      Goto buddy_retry

    buddy_manual_exit:
      StrCpy $4 0
      StrCpy $1 "Lexora 仍在运行。请从系统托盘选择退出，等待退出完成后重试。$\r$\n$\r$\nLexora is still running. Quit from the system tray, then retry after it exits."

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

!macro customPageAfterChangeDir
  !include StrContains.nsh

  Function BuddyDirectoryPre
    ${If} ${isUpdated}
    ${OrIf} $perUserInstallationFolder != ""
      Abort
    ${EndIf}
  FunctionEnd

  !define MUI_PAGE_CUSTOMFUNCTION_PRE BuddyDirectoryPre
  !insertmacro MUI_PAGE_DIRECTORY

  Function BuddyInstFilesPre
    ${If} $perUserInstallationFolder == ""
      ${StrContains} $0 "${APP_FILENAME}" $INSTDIR
      ${If} $0 == ""
        StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
      ${EndIf}
    ${EndIf}
  FunctionEnd

  !define MUI_PAGE_CUSTOMFUNCTION_PRE BuddyInstFilesPre
!macroend

!macro BuddyAcquireInstallationMutex
  System::Call 'kernel32::CreateMutex(p 0, i 1, t "Local\lexora-buddy-installation") p.r0'
  StrCpy $BuddyInstallMutex $0
  StrCmp $BuddyInstallMutex "0" 0 +3
    SetErrorLevel 1603
    Abort
!macroend

!macro customInit
  Push $0
  UserInfo::GetAccountType
  Pop $0
  ${If} $0 != "User"
    IfSilent 0 buddy_require_limited_install
    ${If} ${isUpdated}
    ${OrIf} ${isForceRun}
      Goto buddy_require_limited_install
    ${EndIf}
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    StrCmp $0 "" 0 buddy_require_limited_install
    ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
    StrCmp $0 "" 0 buddy_require_limited_install
    !ifdef UNINSTALL_REGISTRY_KEY_2
      ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
      StrCmp $0 "" 0 buddy_require_limited_install
    !endif
    ${If} $INSTDIR != ""
      IfFileExists "$INSTDIR\*.*" buddy_require_limited_install
    ${EndIf}
  ${EndIf}
  Goto buddy_install_token_checked
  buddy_require_limited_install:
    IfSilent +2
    MessageBox MB_OK|MB_ICONSTOP "请使用普通用户权限安装或修复 Lexora Buddy。$\r$\nRun this installer without administrator privileges."
    SetErrorLevel 1603
    Quit
  buddy_install_token_checked:
  Pop $0
  !insertmacro BuddyAcquireInstallationMutex
!macroend

!macro customUnInit
  !insertmacro BuddyAcquireInstallationMutex
!macroend

!macro customInstall
  Push $0
  UserInfo::GetAccountType
  Pop $0
  ${If} $0 == "User"
    DetailPrint "正在校验安装文件 / Verifying installed files..."
    nsExec::Exec /TIMEOUT=30000 '"$INSTDIR\resources\lexora-runtime\node.exe" "$INSTDIR\resources\lexora-service\service.mjs" --verify-install'
    Pop $0
    ${If} $0 != "0"
      Delete "$INSTDIR\resources\release-set.json"
      DetailPrint "安装文件校验失败 / Installed file verification failed."
      IfSilent +2
      MessageBox MB_OK|MB_ICONSTOP "安装文件校验失败。请重新安装。$\r$\nInstalled file verification failed. Please reinstall."
      SetErrorLevel 1603
      Quit
    ${EndIf}
    StrCpy $0 "verified"
  ${Else}
    DetailPrint "文件已解包；首次以普通用户运行时完成全量校验。 / Files staged; full verification is required at first user activation."
  ${EndIf}
  System::Call 'kernel32::ReleaseMutex(p $BuddyInstallMutex)'
  System::Call 'kernel32::CloseHandle(p $BuddyInstallMutex)'
  ${If} $0 == "verified"
  ${AndIf} ${Silent}
  ${AndIf} ${isUpdated}
    Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --updated'
  ${EndIf}
  Pop $0
!macroend

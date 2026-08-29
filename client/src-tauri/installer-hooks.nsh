; GameTalk NSIS installer hooks: a tray-resident GameTalk.exe locks the install files
; and blocks in-place upgrades. Terminate the process tree before install/uninstall.
!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /F /T /IM GameTalk.exe'
  Sleep 600
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /T /IM GameTalk.exe'
  Sleep 600
!macroend

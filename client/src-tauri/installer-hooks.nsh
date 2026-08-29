; GameTalk NSIS 安装钩子：托盘常驻的 GameTalk.exe 会锁住安装文件，
; 不先结束进程就无法覆盖升级（用户被迫先卸载）。安装/卸载前自动结束进程树。
!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /F /T /IM GameTalk.exe'
  Sleep 600
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /T /IM GameTalk.exe'
  Sleep 600
!macroend

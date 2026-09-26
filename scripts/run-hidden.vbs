' ===========================================================================
' run-hidden.vbs - start the heartbeat without any console window
' ===========================================================================
' A scheduled task that runs powershell.exe directly always flashes a console
' window, even with -WindowStyle Hidden. wscript.exe is a GUI process with no
' console, and window style 0 asks Windows to create the child hidden, so this
' launcher produces no visible window at all.
'
' Registered as the scheduled task action:
'   wscript.exe //B //Nologo "<this file>" -Watch
' Any arguments after the script name are forwarded to update_status.ps1.
'
' ASCII-only on purpose: wscript reads .vbs files as ANSI.
' ===========================================================================
Option Explicit

Dim fso, sh, base, ps1, cmd, i, extra

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = base & "\update_status.ps1"

If Not fso.FileExists(ps1) Then
    WScript.Quit 1
End If

extra = ""
For i = 0 To WScript.Arguments.Count - 1
    extra = extra & " " & WScript.Arguments(i)
Next

cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & ps1 & """" & extra

' 0 = hidden window, False = do not wait for the child to finish
sh.Run cmd, 0, False

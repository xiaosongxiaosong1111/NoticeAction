Option Explicit

Dim shell, fso, projectRoot, startScript, powershellPath, appUrl, command, healthStatus, attempt
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

projectRoot = fso.GetParentFolderName(WScript.ScriptFullName)
startScript = fso.BuildPath(projectRoot, "start.ps1")
powershellPath = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
appUrl = "http://127.0.0.1:43173"
healthStatus = GetHealthStatus(appUrl & "/api/health")

If healthStatus = -1 Then
  MsgBox "An older or incompatible local service is using port 43173. Close that Node.js process, then run this launcher again.", 48, "NoticeAction"
  WScript.Quit 1
End If

If healthStatus = 0 Then
  command = """" & powershellPath & """ -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & startScript & """"
  shell.Run command, 0, False

  For attempt = 1 To 100
    WScript.Sleep 100
    healthStatus = GetHealthStatus(appUrl & "/api/health")
    If healthStatus <> 0 Then Exit For
  Next
End If

If healthStatus = 1 Then
  shell.Run appUrl, 1, False
ElseIf healthStatus = -1 Then
  MsgBox "Port 43173 is occupied by an incompatible service. Close it, then run this launcher again.", 48, "NoticeAction"
Else
  MsgBox "NoticeAction failed to start. Make sure Node.js 22 or later is installed.", 16, "NoticeAction"
End If

Function GetHealthStatus(url)
  Dim request, matcher
  GetHealthStatus = 0
  On Error Resume Next
  Set request = CreateObject("MSXML2.XMLHTTP.6.0")
  request.Open "GET", url, False
  request.Send
  If Err.Number = 0 Then
    If request.Status = 0 Then
      GetHealthStatus = 0
    ElseIf request.Status = 200 Then
      Set matcher = New RegExp
      matcher.Pattern = "^\{""ok"":true,""service_id"":""notice-action-local-v1"",""credential_management_version"":1,""live_parse_configured"":(true|false),""credentials_saved"":(true|false),""credential_storage_available"":true,""credential_storage_error"":(true|false)\}$"
      matcher.IgnoreCase = False
      matcher.Global = False
      If matcher.Test(request.ResponseText) Then GetHealthStatus = 1 Else GetHealthStatus = -1
      Set matcher = Nothing
    Else
      GetHealthStatus = -1
    End If
  End If
  Set request = Nothing
  Err.Clear
  On Error GoTo 0
End Function

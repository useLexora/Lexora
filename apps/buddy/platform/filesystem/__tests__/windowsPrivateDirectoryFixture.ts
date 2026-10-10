import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'

export function inspectWindowsPrivateDirectory(path: string, sddl?: string): { sddl: string, owner: string, protected: boolean, user: string, allows: string[], inherited: boolean[] } {
  const script = `
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$request=[Console]::In.ReadToEnd() | ConvertFrom-Json
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if($request.sddl){
  $security=[Security.AccessControl.DirectorySecurity]::new()
  $security.SetSecurityDescriptorSddlForm($request.sddl.Replace('CURRENT',$user),[Security.AccessControl.AccessControlSections]::Access)
  [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($request.path),$security)
}
$acl=Get-Acl -LiteralPath $request.path
$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object AccessControlType -EQ 'Allow')
@{sddl=$acl.Sddl;owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;protected=$acl.AreAccessRulesProtected;user=$user;allows=@($rules | ForEach-Object {$_.IdentityReference.Value});inherited=@($rules | ForEach-Object {$_.IsInherited})} | ConvertTo-Json -Compress
`
  return JSON.parse(execFileSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-OutputFormat',
    'Text',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], { input: JSON.stringify({ path, sddl }), encoding: 'utf8', windowsHide: true, timeout: 15_000 }))
}

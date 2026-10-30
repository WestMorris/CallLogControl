$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell.exe -Verb RunAs -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"')
    exit
}
Add-Type -AssemblyName System.Windows.Forms
$form = [Windows.Forms.Form]::new()
$form.Text = 'CallLog Control - Administracion'
$form.Size = [Drawing.Size]::new(620,210)
$form.StartPosition = 'CenterScreen'
$label = [Windows.Forms.Label]::new()
$label.Text = 'Copia la clave y pegala en el panel. No la compartas con los telefonos.'
$label.SetBounds(20,20,560,30)
$key = [Windows.Forms.TextBox]::new()
$key.Text = (Get-Content -Raw (Join-Path $env:ProgramData 'CallLogControl\admin-key.txt')).Trim()
$key.ReadOnly = $true
$key.UseSystemPasswordChar = $true
$key.SetBounds(20,55,560,30)
$button = [Windows.Forms.Button]::new()
$button.Text = 'Copiar clave y abrir panel'
$button.SetBounds(20,100,300,40)
$button.Add_Click({ [Windows.Forms.Clipboard]::SetText($key.Text); Start-Process 'http://127.0.0.1:8088/' })
$form.Controls.AddRange(@($label,$key,$button))
[void]$form.ShowDialog()

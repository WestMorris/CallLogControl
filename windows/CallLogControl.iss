#ifndef PayloadDir
  #error Define PayloadDir mediante Build-Installer.ps1
#endif
#ifndef OutputDir
  #define OutputDir "..\build\windows"
#endif
#define AppVersion "1.2.0"

[Setup]
AppId={{75A2046F-B593-46B3-B39E-359BA1229807}
AppName=CallLog Control Server
AppVersion={#AppVersion}
AppPublisher=Facundo Duette
AppPublisherURL=https://github.com/WestMorris/CallLogControl
DefaultDirName={autopf}\CallLogControl
DefaultGroupName=CallLog Control
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=CallLogControl-Setup-{#AppVersion}-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
UninstallDisplayIcon={app}\CallLogControlAPI.exe
LicenseFile=..\LICENSE

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Administrar CallLog Control"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\windows\Open-Admin.ps1"""
Name: "{group}\Panel web"; Filename: "http://127.0.0.1:8088/"
Name: "{group}\Desinstalar"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Administrar CallLog Control"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\windows\Open-Admin.ps1"""

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\windows\Open-Admin.ps1"""; Description: "Abrir administracion (copiar clave y abrir panel)"; Flags: postinstall skipifsilent nowait runasoriginaluser; Check: ServicesReady

[UninstallDelete]
Type: files; Name: "{app}\CallLogControlAPI.xml"
Type: files; Name: "{app}\CallLogControlHTTPS.xml"

[Code]
var NetworkPage: TInputQueryWizardPage;
    InstallationFailed: Boolean;

function ServicesReady: Boolean;
begin
  Result := not InstallationFailed;
end;

function GetCustomSetupExitCode: Integer;
begin
  if InstallationFailed then Result := 1 else Result := 0;
end;

function ServiceArgs(Action: String): String;
begin
  Result := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\windows\Setup-Services.ps1') + '" -InstallDir "' + ExpandConstant('{app}') + '" ' + Action;
end;

procedure InitializeWizard;
begin
  NetworkPage := CreateInputQueryPage(wpSelectDir, 'Conexion con los telefonos', 'Direccion del servidor en la red local',
    'Deja auto para conservar la IP de una instalacion existente o detectar la IP en la primera instalacion. Para cambiarla, escribe la IPv4 del PC. Los telefonos deben estar en la misma red.');
  NetworkPage.Add('IP del servidor (auto o IPv4):', False);
  NetworkPage.Values[0] := ExpandConstant('{param:LANIP|auto}');
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var I: Integer; Value: String;
begin
  Result := True;
  if CurPageID = NetworkPage.ID then begin
    Value := Trim(NetworkPage.Values[0]);
    Result := Value <> '';
    if Value <> 'auto' then
      for I := 1 to Length(Value) do
        if Pos(Value[I], '0123456789.') = 0 then Result := False;
    if not Result then MsgBox('Escribe auto o una direccion IPv4. La IP se verificara antes de iniciar los servicios.', mbError, MB_OK);
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var ExitCode: Integer;
begin
  Result := '';
  if FileExists(ExpandConstant('{app}\windows\Setup-Services.ps1')) then
    if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), ServiceArgs('-StopOnly'), '', SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
      Result := 'No se pudieron detener los servicios anteriores. Los datos se conservaron; revisa los servicios de Windows.';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var ExitCode: Integer;
begin
  if CurStep = ssPostInstall then
    if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), ServiceArgs('-LanIP "' + Trim(NetworkPage.Values[0]) + '"'), '', SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then begin
      InstallationFailed := True;
      RaiseException('No se pudieron iniciar los servicios. Los datos se conservaron. Revisa C:\ProgramData\CallLogControl\setup-error.txt y logs, corrige la causa y vuelve a ejecutar el instalador.');
    end;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpFinished) and InstallationFailed then begin
    WizardForm.FinishedHeadingLabel.Caption := 'El servidor necesita reparacion';
    WizardForm.FinishedLabel.Caption := 'No se pudieron iniciar los servicios. Los datos se conservaron. Revisa setup-error.txt en ProgramData\CallLogControl y vuelve a ejecutar el instalador despues de corregir la causa.';
  end;
end;

function InitializeUninstall: Boolean;
var ExitCode: Integer;
begin
  Result := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), ServiceArgs('-Remove'), '', SW_HIDE, ewWaitUntilTerminated, ExitCode) and (ExitCode = 0);
  if not Result then MsgBox('No se pudieron quitar los servicios. No se borraran los archivos del programa. Revisa los servicios de Windows.', mbError, MB_OK);
end;

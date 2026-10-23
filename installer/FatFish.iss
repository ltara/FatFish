; FatFish Windows client — Inno Setup
; Build on Windows with Inno Setup 6: installer\build.ps1
; Output: Output\FatFish-Setup.exe
; User-facing name: Windows 客户端安装包 — do not put internal component names in wizard text

#define MyAppName "肥鱼"
#define MyAppVersion "0.1.0"
#define MyAppPublisher "FatFish"
#define MyAppExeName "FatFish.bat"
#define MyAppId "{{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\FatFish
DefaultGroupName=肥鱼
DisableProgramGroupPage=yes
OutputDir=Output
OutputBaseFilename=FatFish-Setup
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面图标"; GroupDescription: "附加图标:"; Flags: unchecked

[Files]
Source: "..\dist\FatFish\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\肥鱼"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{group}\卸载肥鱼"; Filename: "{uninstallexe}"
Name: "{autodesktop}\肥鱼"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "立即运行肥鱼"; Flags: nowait postinstall skipifsilent; WorkingDir: "{app}"

[Code]
function InitializeSetup(): Boolean;
begin
  Result := True;
end;

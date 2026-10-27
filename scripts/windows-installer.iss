; Installer for the MusicDownloader desktop helper.
; A fixed AppId is what makes a newer download replace the installed copy
; instead of leaving two of them behind.
#define AppName "MusicDownloader Helper"
#define AppPublisher "MusicDownloader"
#define AppUrl "https://github.com/cristonj/MusicDownloader"
#define AppExe "MusicDownloader-Helper.exe"
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef SourceExe
  #define SourceExe "..\helper-dist\MusicDownloader-Helper-win32-x64.exe"
#endif
#ifndef IconFile
  #define IconFile "..\.helper-build\app.ico"
#endif

[Setup]
AppId={{6F1D5C3A-9A6E-4D2F-9C4B-5A1E0C7B3D21}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
VersionInfoVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}
AppUpdatesURL={#AppUrl}/releases/tag/helper-v1
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
; Per-user by default, so an unsigned helper needs no administrator prompt.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=MusicDownloader-Helper-Windows-Setup
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
; The payload is one large executable, so the slowest compression pays off.
Compression=lzma2/ultra64
LZMAUseSeparateProcess=yes
LZMANumBlockThreads=2
SolidCompression=yes
WizardStyle=modern
; An open helper holds its own file; close it so an update can replace it.
CloseApplications=yes
CloseApplicationsFilter=*.exe
RestartApplications=no
AllowNoIcons=yes

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked
Name: "startup"; Description: "Open the helper when I sign in"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
Source: "{#SourceExe}"; DestName: "{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon
Name: "{userstartup}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: startup

[Run]
Filename: "{app}\{#AppExe}"; Description: "Open {#AppName} now"; Flags: nowait postinstall skipifsilent

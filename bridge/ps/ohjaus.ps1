# JARVIS: hiiri, näppäimet, ikkunan vaihto ja liittäminen (kone_klikkaa / kone_nappain / kone_vierita / kone_ikkuna / kone_liita / kone_naytto).
# Ajetaan tiedostona (-File): Defender estää saman koodin -Command-rivinä. Toiminnot ovat kiinteitä; ei vapaata koodia.
param([Parameter(Mandatory = $true)][ValidateSet('klikkaa', 'nappain', 'vierita', 'heratys', 'naytto_pois', 'ikkuna', 'liita', 'raahaa', 'unicode')][string]$Toiminto,
  [string]$A = '', [string]$B = '', [string]$C = '', [string]$D = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class JarvisW32 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
'@
[JarvisW32]::SetProcessDPIAware() | Out-Null
function KeyDown([int]$c) { [JarvisW32]::keybd_event([byte]$c, 0, 0, [UIntPtr]::Zero) }
function KeyUp([int]$c) { [JarvisW32]::keybd_event([byte]$c, 0, 2, [UIntPtr]::Zero) }
function Press([int[]]$codes) {
  foreach ($c in $codes) { KeyDown $c }
  Start-Sleep -Milliseconds 60
  for ($i = $codes.Count - 1; $i -ge 0; $i--) { KeyUp $codes[$i] }
}
switch ($Toiminto) {
  'klikkaa' {
    # A=x B=y C=vasen|oikea D=1 (tuplaklikkaus)
    [JarvisW32]::SetCursorPos([int]$A, [int]$B) | Out-Null
    Start-Sleep -Milliseconds 80
    $down = 0x02; $up = 0x04
    if ($C -eq 'oikea') { $down = 0x08; $up = 0x10 }
    $times = 1; if ($D -eq '1') { $times = 2 }
    for ($i = 0; $i -lt $times; $i++) {
      if ($i -gt 0) { Start-Sleep -Milliseconds 90 }
      [JarvisW32]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40; [JarvisW32]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
    }
    'OK'
  }
  'nappain' {
    # A = virtuaalinäppäinkoodit pilkuilla (esim. 17,83 = ctrl+s)
    Press ([int[]]($A -split ',' | Where-Object { $_ -ne '' } | ForEach-Object { [int]$_ }))
    'OK'
  }
  'raahaa' {
    # A=x1 B=y1 C=x2 D=y2 (NÄYTTÖ-sivun hiirellä raahaus): painallus, liike 12 askeleessa, vapautus.
    $x1 = [int]$A; $y1 = [int]$B; $x2 = [int]$C; $y2 = [int]$D
    [JarvisW32]::SetCursorPos($x1, $y1) | Out-Null
    Start-Sleep -Milliseconds 60
    [JarvisW32]::mouse_event(0x02, 0, 0, 0, [UIntPtr]::Zero)
    for ($i = 1; $i -le 12; $i++) {
      Start-Sleep -Milliseconds 18
      [JarvisW32]::SetCursorPos([int]($x1 + ($x2 - $x1) * $i / 12), [int]($y1 + ($y2 - $y1) * $i / 12)) | Out-Null
    }
    Start-Sleep -Milliseconds 60
    [JarvisW32]::mouse_event(0x04, 0, 0, 0, [UIntPtr]::Zero)
    'OK'
  }
  'vierita' {
    # A=x B=y C=rullan määrä (positiivinen = alas)
    [JarvisW32]::SetCursorPos([int]$A, [int]$B) | Out-Null
    [JarvisW32]::mouse_event(0x0800, 0, 0, (-120 * [int]$C), [UIntPtr]::Zero)
    'OK'
  }
  'heratys' {
    Press @(0x10)
    [JarvisW32]::mouse_event(0x0001, 1, 0, 0, [UIntPtr]::Zero); [JarvisW32]::mouse_event(0x0001, -1, 0, 0, [UIntPtr]::Zero)
    'OK'
  }
  'naytto_pois' {
    Start-Sleep -Milliseconds 300
    [JarvisW32]::SendMessage([IntPtr]0xFFFF, 0x0112, [IntPtr]0xF170, [IntPtr]2) | Out-Null
    'OK'
  }
  'ikkuna' {
    # A = otsikon tai ohjelman nimen osa
    $q = $A
    $w = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and ($_.MainWindowTitle -like "*$q*" -or $_.ProcessName -like "*$q*") } | Select-Object -First 1
    if (-not $w) { "EI`t" + ((Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.MainWindowTitle }) -join "`n"); break }
    # ALT-napautus: Windows sallii SetForegroundWindow taustaprosessilta vasta tämän jälkeen.
    Press @(0x12)
    if ([JarvisW32]::IsIconic($w.MainWindowHandle)) { [JarvisW32]::ShowWindow($w.MainWindowHandle, 9) | Out-Null }
    [JarvisW32]::SetForegroundWindow($w.MainWindowHandle) | Out-Null
    (New-Object -ComObject WScript.Shell).AppActivate($w.Id) | Out-Null
    "OK`t" + $w.MainWindowTitle
  }
  'liita' {
    # A = teksti base64 (UTF-8), B = 1 → Enter perään. Käyttäjän leikepöytä palautetaan.
    $old = Get-Clipboard -Raw -ErrorAction SilentlyContinue
    $t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($A))
    Set-Clipboard -Value $t; Start-Sleep -Milliseconds 150
    Press @(0x11, 0x56); Start-Sleep -Milliseconds 700
    if ($B -eq '1') { Press @(0x0D); Start-Sleep -Milliseconds 300 }
    if ($old) { Set-Clipboard -Value $old }
    'OK'
  }
  'unicode' {
    # A = teksti base64 (UTF-8). NÄYTTÖ-sivun suora kirjoitus, varatie naytto.ps1:n "teksti"-komennolle:
    # SendInput KEYEVENTF_UNICODE (ä, ö, å, emoji) ilman leikepöytää; rivinvaihto = Enter.
    Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class JarvisUni {
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  static INPUT Key(ushort vk, ushort scan, uint flags) { INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }
  public static void Text(string s) {
    foreach (char c in s) {
      if (c == '\r') continue;
      INPUT[] a = c == '\n' ? new INPUT[] { Key(0x0D, 0, 0), Key(0x0D, 0, 2) } : new INPUT[] { Key(0, (ushort)c, 4), Key(0, (ushort)c, 6) };
      SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT)));
    }
  }
}
'@
    [JarvisUni]::Text([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($A)))
    'OK'
  }
}

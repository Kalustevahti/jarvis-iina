# JARVIS: NAYTTO page helper. Perustila screen capture (CopyFromScreen, DPI aware, plain ImageFormat.Jpeg) and
# live typing, staying running and answering one command per line on stdin, so nothing pays PowerShell start-up.
# Commands (fixed, no free code):
#   naytot                  -> "NAYTOT i,primary,x,y,w,h;..."  (physical pixels)
#   kuva <i> <maxW> <file>  -> "OK x y w h sw sh"  (monitor i, scaled to at most maxW wide)
#   teksti <base64 utf-8>   -> "OK"  (SendInput KEYEVENTF_UNICODE: ä, ö, å, emoji; newline = Enter)
#   nappain <vk,vk> <times> -> "OK"  (virtual keys held together, released in reverse; repeated <times>)
#   loppu                   -> exit
# Errors: "VIRHE <message>" (the bridge skips that frame / uses ohjaus.ps1).
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class JarvisDpiN {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  static INPUT Key(ushort vk, ushort scan, uint flags) { INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }
  public static void Text(string s) {
    foreach (char c in s) {
      if (c == '\r') continue;
      INPUT[] a;
      if (c == '\n') a = new INPUT[] { Key(0x0D, 0, 0), Key(0x0D, 0, 2) };
      else a = new INPUT[] { Key(0, (ushort)c, 4), Key(0, (ushort)c, 4 | 2) };
      SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT)));
    }
  }
  public static void Keys(ushort[] vks) {
    INPUT[] a = new INPUT[vks.Length * 2];
    for (int i = 0; i < vks.Length; i++) a[i] = Key(vks[i], 0, Ext(vks[i]));
    for (int i = 0; i < vks.Length; i++) { ushort v = vks[vks.Length - 1 - i]; a[vks.Length + i] = Key(v, 0, Ext(v) | 2); }
    SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT)));
  }
  // Arrows, Home/End, Delete and Win are extended keys.
  static uint Ext(ushort v) { return (v >= 0x21 && v <= 0x28) || v == 0x2E || v == 0x5B ? 1u : 0u; }
}
'@
[JarvisDpiN]::SetProcessDPIAware() | Out-Null
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq 'loppu') { break }
  try {
    $p = $line.Split(' ', 4)
    if ($p[0] -eq 'naytot') {
      $all = [System.Windows.Forms.Screen]::AllScreens
      $out = @()
      for ($i = 0; $i -lt $all.Length; $i++) {
        $b = $all[$i].Bounds
        $pr = 0; if ($all[$i].Primary) { $pr = 1 }
        $out += "$i,$pr,$($b.X),$($b.Y),$($b.Width),$($b.Height)"
      }
      [Console]::Out.WriteLine('NAYTOT ' + ($out -join ';'))
    } elseif ($p[0] -eq 'kuva' -and $p.Length -eq 4) {
      $all = [System.Windows.Forms.Screen]::AllScreens
      $idx = [int]$p[1]; if ($idx -lt 0 -or $idx -ge $all.Length) { $idx = 0 }
      $maxW = [int]$p[2]
      $file = $p[3]
      $b = $all[$idx].Bounds
      $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
      $g.Dispose()
      $w = $b.Width; $h = $b.Height
      if ($maxW -gt 0 -and $maxW -lt $b.Width) {
        $w = $maxW; $h = [int]($b.Height * $w / $b.Width)
        $small = New-Object System.Drawing.Bitmap $bmp, $w, $h
        $bmp.Dispose(); $bmp = $small
      }
      $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Jpeg)
      $bmp.Dispose()
      [Console]::Out.WriteLine("OK $($b.X) $($b.Y) $($b.Width) $($b.Height) $w $h")
    } elseif ($p[0] -eq 'teksti' -and $p.Length -eq 2) {
      [JarvisDpiN]::Text([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1])))
      [Console]::Out.WriteLine('OK')
    } elseif ($p[0] -eq 'nappain' -and $p.Length -eq 3) {
      $codes = [uint16[]]($p[1] -split ',' | Where-Object { $_ -ne '' } | ForEach-Object { [int]$_ })
      $times = [Math]::Max(1, [Math]::Min(50, [int]$p[2]))
      for ($i = 0; $i -lt $times; $i++) { [JarvisDpiN]::Keys($codes); if ($codes.Length -gt 1) { Start-Sleep -Milliseconds 30 } }
      [Console]::Out.WriteLine('OK')
    } else {
      [Console]::Out.WriteLine('VIRHE tuntematon komento')
    }
  } catch {
    [Console]::Out.WriteLine('VIRHE ' + ($_.Exception.Message -replace '\s+', ' '))
  }
  [Console]::Out.Flush()
}

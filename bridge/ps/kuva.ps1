# JARVIS: kuvakaappaus kaikista näytöistä JPEG-tiedostoon (kone_nayta / kone_kuvakaappaus).
# Ajetaan tiedostona (-File). Defender (AMSI) estää -Command-rivin ja myös JPEG-laatuasetuksen (ImageCodecInfo/EncoderParameters)
# tämän kanssa samassa skriptissä, joten tallennus on tavallinen ImageFormat.Jpeg (5.11.2026 testattu koneella).
param([Parameter(Mandatory = $true)][string]$Tiedosto, [int]$MaxW = 0)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class JarvisDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[JarvisDpi]::SetProcessDPIAware() | Out-Null
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$g.Dispose()
$w = $b.Width; $h = $b.Height
if ($MaxW -gt 0 -and $MaxW -lt $b.Width) {
  $w = $MaxW; $h = [int]($b.Height * $w / $b.Width)
  $small = New-Object System.Drawing.Bitmap $bmp, $w, $h
  $bmp.Dispose(); $bmp = $small
}
$bmp.Save($Tiedosto, [System.Drawing.Imaging.ImageFormat]::Jpeg)
$bmp.Dispose()
"$($b.Left) $($b.Top) $($b.Width) $($b.Height) $w $h"

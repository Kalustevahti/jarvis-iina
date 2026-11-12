# JARVIS: NAYTTO page focus watcher (10.11.2026). Runs ONLY while the screen stream is on (naytto.mjs starts and
# kills it). Polls the UI Automation focused element every 250 ms and prints a line only when it changes:
#   FOKUS 0                      not a text field
#   FOKUS 1 x y w h s            editable text field, bounding box in physical pixels, s = 1 password field
# Never reads or prints the field's content. Exits when the bridge process (-Vanhempi) is gone.
param([int]$Vanhempi = 0)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class JarvisDpiF { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[JarvisDpiF]::SetProcessDPIAware() | Out-Null
$AE = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
$VP = [System.Windows.Automation.ValuePattern]::Pattern
$TP = [System.Windows.Automation.TextPattern]::Pattern
# Browser page roots expose a TextPattern but are not text fields.
$pageClass = 'Chrome_RenderWidgetHostHWND|MozillaWindowClass|Internet Explorer_Server'
$last = ''
$n = 0
while ($true) {
  $n++
  if ($Vanhempi -gt 0 -and ($n % 16) -eq 0 -and -not (Get-Process -Id $Vanhempi -ErrorAction SilentlyContinue)) { break }
  $out = $null
  try {
    $e = $AE::FocusedElement
    $out = 'FOKUS 0'
    if ($null -ne $e) {
      $c = $e.Current
      $ct = $c.ControlType
      $ro = $null
      $vp = $null
      if ($e.TryGetCurrentPattern($VP, [ref]$vp)) { $ro = [bool]$vp.Current.IsReadOnly }
      $edit = $false
      if ($ct -eq $CT::Edit) { $edit = ($ro -ne $true) }
      elseif ($ct -eq $CT::ComboBox) { $edit = ($ro -eq $false) }
      elseif ($ct -eq $CT::Document) {
        if ($ro -eq $false) { $edit = $true }
        elseif ($null -eq $ro) {
          $tp = $null
          if ($e.TryGetCurrentPattern($TP, [ref]$tp) -and ($c.ClassName -notmatch $pageClass)) { $edit = $true }
        }
      }
      if ($edit -and $c.IsEnabled) {
        $r = $c.BoundingRectangle
        $s = 0; if ($c.IsPassword) { $s = 1 }
        if ($r.IsEmpty -or [double]::IsInfinity($r.Width)) { $out = "FOKUS 1 0 0 0 0 $s" }
        else { $out = 'FOKUS 1 {0} {1} {2} {3} {4}' -f [int]$r.X, [int]$r.Y, [int][Math]::Max(0, $r.Width), [int][Math]::Max(0, $r.Height), $s }
      }
    }
  } catch {
    $out = $null # element vanished mid-read: keep the last state
  }
  if ($null -ne $out -and $out -ne $last) {
    $last = $out
    [Console]::Out.WriteLine($out)
    [Console]::Out.Flush()
  }
  Start-Sleep -Milliseconds 250
}

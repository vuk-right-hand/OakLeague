# Generates public/spike-a/canned-question.pcm
# SAPI SetOutputToAudioStream with SpeechAudioFormatInfo emits RAW PCM directly
# (no RIFF header). Target: PCM16 @ 16kHz mono LE, duration in [2s, 5s].
Add-Type -AssemblyName System.Speech

$text = "What's the most important mindset shift for an aspiring entrepreneur?"

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$stream = New-Object System.IO.MemoryStream

$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)

$synth.SetOutputToAudioStream($stream, $fmt)
$synth.Rate = 2   # faster; target 2-4s
$synth.Speak($text)
$synth.Dispose()

$pcm = $stream.ToArray()
$stream.Dispose()

$durationSec = $pcm.Length / 2 / 16000
Write-Host ("raw PCM bytes: {0}, duration: {1:N2}s" -f $pcm.Length, $durationSec)

if ($durationSec -lt 2 -or $durationSec -gt 5) {
  throw "duration out of [2s, 5s] target: $durationSec"
}

$outPath = "public/spike-a/canned-question.pcm"
[System.IO.File]::WriteAllBytes($outPath, $pcm)
Write-Host "wrote $outPath"

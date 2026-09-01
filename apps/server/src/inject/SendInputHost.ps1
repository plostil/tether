# SendInputHost.ps1 — persistent input-injection helper for the Tether broker.
#
# Spawned ONCE by apps/server/src/inject/injector.ts and kept alive; it reads a
# trivial line protocol from stdin (no JSON, so dispatch stays sub-millisecond)
# and calls the Win32 SendInput API. The Add-Type C# compile happens a single
# time at startup, never per event.
#
# Line protocol (one command per line, space-separated):
#   m <x> <y>            mouse move, absolute, x/y in 0..65535 (primary monitor)
#   d <btn>              mouse button down: 0=left 1=middle 2=right
#   u <btn>              mouse button up
#   w <dx> <dy>          wheel: dy vertical, dx horizontal, in wheel-delta units
#   k <scan> <down> <ext>  key by scancode: down 1|0, ext 1|0 (extended key)
#   t <base64-utf8>      type unicode text (base64 of UTF-8 bytes)
#
# v1 limitation: MOUSEEVENTF_ABSOLUTE maps 0..65535 to the PRIMARY monitor only
# (no MOUSEEVENTF_VIRTUALDESK). SendInput also cannot reach the secure desktop
# (UAC/lock screen) from a normal user process.

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class TetherInput {
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public INPUTUNION u; }

    const uint INPUT_MOUSE = 0;
    const uint INPUT_KEYBOARD = 1;

    const uint MOUSEEVENTF_MOVE = 0x0001;
    const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
    const uint MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000;

    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;
    const uint KEYEVENTF_SCANCODE = 0x0008;
    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    static void Send(INPUT[] inputs) { SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))); }

    public static void Move(int x, int y) {
        var i = new INPUT { type = INPUT_MOUSE };
        i.u.mi.dx = x; i.u.mi.dy = y;
        i.u.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE;
        Send(new[] { i });
    }
    public static void Button(int btn, bool down) {
        uint f = 0;
        if (btn == 0) f = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
        else if (btn == 1) f = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
        else if (btn == 2) f = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
        else return;
        var i = new INPUT { type = INPUT_MOUSE };
        i.u.mi.dwFlags = f;
        Send(new[] { i });
    }
    public static void Wheel(int dx, int dy) {
        if (dy != 0) {
            var i = new INPUT { type = INPUT_MOUSE };
            i.u.mi.mouseData = unchecked((uint)dy); i.u.mi.dwFlags = MOUSEEVENTF_WHEEL;
            Send(new[] { i });
        }
        if (dx != 0) {
            var i = new INPUT { type = INPUT_MOUSE };
            i.u.mi.mouseData = unchecked((uint)dx); i.u.mi.dwFlags = MOUSEEVENTF_HWHEEL;
            Send(new[] { i });
        }
    }
    public static void Key(ushort scan, bool down, bool extended) {
        var i = new INPUT { type = INPUT_KEYBOARD };
        i.u.ki.wScan = scan;
        uint f = KEYEVENTF_SCANCODE;
        if (!down) f |= KEYEVENTF_KEYUP;
        if (extended) f |= KEYEVENTF_EXTENDEDKEY;
        i.u.ki.dwFlags = f;
        Send(new[] { i });
    }
    public static void Text(string s) {
        foreach (char c in s) {
            var down = new INPUT { type = INPUT_KEYBOARD };
            down.u.ki.wScan = c; down.u.ki.dwFlags = KEYEVENTF_UNICODE;
            var up = new INPUT { type = INPUT_KEYBOARD };
            up.u.ki.wScan = c; up.u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            Send(new[] { down, up });
        }
    }
}
'@

$stdin = [Console]::In
while ($null -ne ($line = $stdin.ReadLine())) {
    if ($line.Length -eq 0) { continue }
    $p = $line.Split(' ')
    try {
        switch ($p[0]) {
            'm' { [TetherInput]::Move([int]$p[1], [int]$p[2]) }
            'd' { [TetherInput]::Button([int]$p[1], $true) }
            'u' { [TetherInput]::Button([int]$p[1], $false) }
            'w' { [TetherInput]::Wheel([int]$p[1], [int]$p[2]) }
            'k' { [TetherInput]::Key([uint16]$p[1], $p[2] -eq '1', $p[3] -eq '1') }
            't' {
                $bytes = [Convert]::FromBase64String($p[1])
                [TetherInput]::Text([System.Text.Encoding]::UTF8.GetString($bytes))
            }
        }
    } catch {
        # A malformed line must never kill the host — skip and keep reading.
    }
}

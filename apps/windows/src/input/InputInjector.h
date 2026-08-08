#pragma once
// phone -> PC input injection (SPEC §2.1).
//
// SendInput from this uiAccess=true, signed, %ProgramFiles%-installed helper can
// drive any normal or elevated window. It CANNOT touch the secure desktop (UAC
// consent, lock screen, Ctrl+Alt+Del) — SendInput silently fails there; that
// case is delegated to tether_service (SYSTEM) which re-attaches a helper into
// Winsta0\Winlogon and injects on that desktop.
//
// Coordinates arrive from the phone in the captured frame's space; convert to
// absolute 0..65535 for MOUSEEVENTF_ABSOLUTE against the virtual screen.

#include <cstdint>

namespace tether::input {

class InputInjector {
public:
    void MoveMouseAbsolute(int screenX, int screenY);
    void MouseButton(int button, bool down);
    void Scroll(int deltaX, int deltaY);
    void Key(uint16_t vkeyOrScan, bool down, bool isScanCode);
    void UnicodeText(const wchar_t* text);

    // True if the current input desktop is the secure desktop, where SendInput
    // is inert and the SYSTEM service must take over.
    static bool IsSecureDesktopActive();
};

} // namespace tether::input

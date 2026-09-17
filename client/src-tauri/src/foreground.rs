//! 游戏模式焦点捕获 / 还原。
//!
//! 呼出输入框前记下当前前台（通常是游戏），发送或 Esc 关闭后再把它唤回。
//! Windows 上 hide() 往往已经能还焦点，这里仍显式还原，三端路径一致。
//! Linux 纯 Wayland（无 DISPLAY）无法可靠还原，捕获/还原都是空操作。

use std::sync::Mutex;

static TOKEN: Mutex<ForegroundToken> = Mutex::new(ForegroundToken::None);

#[derive(Clone, Copy)]
enum ForegroundToken {
    None,
    #[cfg(windows)]
    WinHwnd(isize),
    #[cfg(target_os = "macos")]
    MacPid(i32),
    #[cfg(all(unix, not(target_os = "macos")))]
    X11Window(u32),
}

#[tauri::command]
pub fn capture_foreground() {
    let next = platform_capture().unwrap_or(ForegroundToken::None);
    if let Ok(mut slot) = TOKEN.lock() {
        *slot = next;
    }
}

#[tauri::command]
pub fn restore_foreground() {
    let token = TOKEN.lock().map(|g| *g).unwrap_or(ForegroundToken::None);
    platform_restore(token);
}

#[cfg(windows)]
fn platform_capture() -> Option<ForegroundToken> {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    let hwnd = unsafe { GetForegroundWindow() };
    let raw = hwnd.0 as isize;
    if raw == 0 {
        return None;
    }
    Some(ForegroundToken::WinHwnd(raw))
}

#[cfg(windows)]
fn platform_restore(token: ForegroundToken) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
    let ForegroundToken::WinHwnd(raw) = token else {
        return;
    };
    if raw == 0 {
        return;
    }
    let hwnd = HWND(raw as *mut core::ffi::c_void);
    unsafe {
        let _ = SetForegroundWindow(hwnd);
    }
}

#[cfg(target_os = "macos")]
fn platform_capture() -> Option<ForegroundToken> {
    use objc2_app_kit::{NSRunningApplication, NSWorkspace};
    let workspace = NSWorkspace::sharedWorkspace();
    let app = workspace.frontmostApplication()?;
    let pid = app.processIdentifier();
    if pid <= 0 {
        return None;
    }
    // 不要把 GameTalk 自己记成「要还原的前台」：若呼出时主窗口已在前台，
    // 还原应仍是空操作，避免和输入框抢焦点。
    let self_pid = NSRunningApplication::currentApplication().processIdentifier();
    if pid == self_pid {
        return None;
    }
    Some(ForegroundToken::MacPid(pid as i32))
}

#[cfg(target_os = "macos")]
fn platform_restore(token: ForegroundToken) {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
    let ForegroundToken::MacPid(pid) = token else {
        return;
    };
    if pid <= 0 {
        return;
    }
    let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid as _) else {
        return;
    };
    // NSApplicationActivateIgnoringOtherApps = 1 << 1
    let opts = NSApplicationActivationOptions::from_bits_retain(2);
    let _ = app.activateWithOptions(opts);
}

/// X11：GetInputFocus / SetInputFocus。无 DISPLAY（CI、纯 Wayland）时静默跳过。
#[cfg(all(unix, not(target_os = "macos")))]
fn platform_capture() -> Option<ForegroundToken> {
    use x11rb::protocol::xproto::ConnectionExt;
    let (conn, _) = x11rb::connect(None).ok()?;
    let reply = conn.get_input_focus().ok()?.reply().ok()?;
    // 0 = None, 1 = PointerRoot，都不是可还原的窗口
    if reply.focus < 2 {
        return None;
    }
    Some(ForegroundToken::X11Window(reply.focus))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_restore(token: ForegroundToken) {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{ConnectionExt, InputFocus};
    let ForegroundToken::X11Window(wid) = token else {
        return;
    };
    if wid < 2 {
        return;
    }
    let Ok((conn, _)) = x11rb::connect(None) else {
        return;
    };
    // time=0 即 CurrentTime
    let _ = conn.set_input_focus(InputFocus::PARENT, wid, 0u32);
    let _ = conn.flush();
}

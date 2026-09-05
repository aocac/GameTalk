use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};
use tauri_plugin_deep_link::DeepLinkExt;

/// 彻底退出应用（前端关闭确认弹窗 → 退出）
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// 把字节写入本地文件（图片灯箱「保存」：前端弹保存对话框拿到路径后调用）
#[tauri::command]
fn write_file_bytes(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, data).map_err(|e| e.to_string())
}

/// 运行时设置 WebView 代理（立即生效，无需重启）：
/// - enabled=true 且 addr 非空 → Network.setProxyOverride 走指定代理
/// - enabled=false → 不干预（保持 WebView2 默认行为 = 跟随系统代理）
/// 注意：绝不能用 proxyBypassList:["*"] 之类全局破坏性参数，会导致共享的
/// WebView2 浏览器进程异常、overlay/input 窗口内容加载失败。
#[tauri::command]
fn set_proxy(window: tauri::WebviewWindow, enabled: bool, addr: Option<String>) {
    if !enabled {
        return;
    }
    let _ = window.with_webview(move |webview| {
        #[cfg(windows)]
        {
            use windows_core::{w, HSTRING, PCWSTR};
            let controller = webview.controller();
            if let Ok(core) = unsafe { controller.CoreWebView2() } {
                let rules = addr.unwrap_or_default();
                let params = format!(r#"{{"proxyRules":"{}","proxyBypassList":[]}}"#, rules);
                let params_h = HSTRING::from(params);
                let params_pcw = PCWSTR(params_h.as_ptr());
                let _ = unsafe { core.CallDevToolsProtocolMethod(w!("Network.setProxyOverride"), params_pcw, None) };
            }
        }
        #[cfg(not(windows))]
        {
            let _ = webview;
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // 单实例：Windows 上运行中点击 gametalk:// 链接会启动第二实例，
            // 邀请链接 URL 在第二实例的 argv 里，这里转发给主实例前端处理
            if let Some(url) = args.iter().find(|a| a.starts_with("gametalk://")) {
                let _ = app.emit("deep-link-url", url.clone());
            }
            // 显示并聚焦主窗口
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![quit_app, set_proxy, write_file_bytes])
        .setup(|app| {
            // 注册 gametalk:// 深链协议到当前用户注册表（不依赖安装器行为；
            // 浏览器点击链接 → 系统以本 exe 启动第二实例 → 单实例回调转发）
            app.deep_link().register_all()?;
            // 系统托盘：显示主窗口 / 退出
            let show = MenuItem::with_id(app, "show", "显示 GameTalk", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 GameTalk", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().expect("app icon").clone())
                .tooltip("GameTalk")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // 主窗口点关闭：不直接退出，交给前端选择「退出」或「关闭到托盘」
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.emit("main-close-requested", ());
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

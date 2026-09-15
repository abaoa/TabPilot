// 阻止 Windows release 构建弹出额外控制台窗口，请勿删除
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tab_pilot_lib::run()
}

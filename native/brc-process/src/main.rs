mod diagnostics;
#[cfg(target_os = "macos")]
mod darwin;
mod identity;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(any(target_os = "linux", test))]
mod proc_status;
mod sample;
#[cfg(windows)]
mod windows;

use serde_json::json;
use std::process::ExitCode;

enum Command {
    Inspect,
    Sample,
}

fn main() -> ExitCode {
    let started = std::time::Instant::now();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = match args.first().map(String::as_str) {
        Some("inspect") => Command::Inspect,
        Some("sample") => Command::Sample,
        _ => {
            eprintln!("usage: brc-process <inspect|sample> <pid> [pid...]");
            return ExitCode::FAILURE;
        }
    };
    let pids = match identity::positive_pids(&args[1..]) {
        Ok(pids) => pids,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::FAILURE;
        }
    };
    let mut payload = match command {
        Command::Inspect => {
            #[cfg(windows)]
            let processes = windows::inspect(&pids);
            #[cfg(not(windows))]
            let processes = pids.iter().map(|&pid| identity::row(pid, Err("UNSUPPORTED_PLATFORM"))).collect::<Vec<_>>();
            json!({ "processes": processes })
        }
        Command::Sample => json!({ "samples": sample::collect(&pids) }),
    };
    if diagnostics::enabled() {
        diagnostics::record("main", started.elapsed().as_micros());
        payload["diagnostics"] = diagnostics::summary(started);
    }
    println!("{}", payload);
    ExitCode::SUCCESS
}

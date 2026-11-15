mod diagnostics;
mod identity;
#[cfg(windows)]
mod windows;

use serde_json::json;
use std::process::ExitCode;

fn main() -> ExitCode {
    let started = std::time::Instant::now();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("inspect") {
        eprintln!("usage: brc-process inspect <pid> [pid...]");
        return ExitCode::FAILURE;
    }
    let pids = match brc_probe!("positive_pids", { identity::positive_pids(&args[1..]) }) {
        Ok(pids) => pids,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::FAILURE;
        }
    };
    #[cfg(windows)]
    let processes = brc_probe!("inspect", { windows::inspect(&pids) });
    #[cfg(not(windows))]
    let processes = pids.iter().map(|&pid| identity::row(pid, Err("UNSUPPORTED_PLATFORM"))).collect::<Vec<_>>();
    let mut payload = json!({ "processes": processes });
    if diagnostics::enabled() {
        payload["diagnostics"] = diagnostics::summary(started);
    }
    println!("{}", payload);
    ExitCode::SUCCESS
}

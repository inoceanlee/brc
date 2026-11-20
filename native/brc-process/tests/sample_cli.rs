use serde_json::Value;
use std::process::Command;

fn run(args: &[&str]) -> (bool, String, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_brc-process"))
        .args(args)
        .output()
        .expect("run brc-process");
    (
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

fn parse(stdout: &str) -> Value {
    serde_json::from_str(stdout.trim()).expect("valid JSON on stdout")
}

#[test]
fn sample_emits_full_contract_for_current_process() {
    let pid = std::process::id().to_string();
    let (ok, stdout, stderr) = run(&["sample", &pid]);
    assert!(ok, "stderr: {stderr}");
    let value = parse(&stdout);
    let samples = value["samples"].as_array().expect("samples array");
    assert_eq!(samples.len(), 1);
    let entry = &samples[0];
    assert_eq!(entry["pid"].as_u64(), Some(std::process::id() as u64));
    assert_eq!(entry["status"].as_str(), Some("found"));
    assert!(entry["cpuUserMs"].as_f64().is_some());
    assert!(entry["cpuSystemMs"].as_f64().is_some());
    assert!(entry.get("cpuPercent").is_some());
    assert!(entry["rssBytes"].as_u64().is_some());
    assert!(entry.get("systemPeakBytes").is_some());
    assert!(entry.get("peak").is_some());
    assert!(entry.get("unavailable").is_some());
    assert!(value.get("diagnostics").is_none());
}

#[test]
fn sample_rejects_invalid_pid_without_stdout() {
    let (ok, stdout, stderr) = run(&["sample", "0"]);
    assert!(!ok);
    assert!(stdout.trim().is_empty());
    assert!(!stderr.trim().is_empty());
}

#[test]
fn sample_accepts_multiple_pids_in_order() {
    let pid = std::process::id().to_string();
    let (ok, stdout, stderr) = run(&["sample", &pid, &pid, "999999"]);
    assert!(ok, "stderr: {stderr}");
    let value = parse(&stdout);
    let samples = value["samples"].as_array().expect("samples array");
    assert_eq!(samples.len(), 2);
    assert_eq!(samples[0]["pid"].as_u64(), Some(std::process::id() as u64));
    assert_eq!(samples[1]["status"].as_str(), Some("not_found"));
}

#[test]
fn inspect_contract_stays_unchanged() {
    let pid = std::process::id().to_string();
    let (ok, stdout, stderr) = run(&["inspect", &pid]);
    assert!(ok, "stderr: {stderr}");
    let value = parse(&stdout);
    assert!(value["processes"].as_array().is_some());
    assert!(value.get("samples").is_none());
    assert!(value.get("diagnostics").is_none());
}

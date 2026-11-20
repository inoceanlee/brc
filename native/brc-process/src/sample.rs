use serde_json::{Value, json};

#[derive(Clone, Debug)]
pub struct RawSample {
    pub cpu_user_ms: f64,
    pub cpu_system_ms: f64,
    pub rss_bytes: u64,
    pub system_peak_bytes: Option<u64>,
    pub window_ms: u64,
    pub source: &'static str,
}

#[cfg(windows)]
fn read_sample(pid: u32) -> Result<Option<RawSample>, &'static str> {
    let _timer = crate::diagnostics::ScopeTimer::new("sample::read_sample");
    crate::windows::sample(pid)
}

#[cfg(target_os = "linux")]
fn read_sample(pid: u32) -> Result<Option<RawSample>, &'static str> {
    let _timer = crate::diagnostics::ScopeTimer::new("sample::read_sample");
    crate::linux::sample(pid)
}

#[cfg(target_os = "macos")]
fn read_sample(pid: u32) -> Result<Option<RawSample>, &'static str> {
    let _timer = crate::diagnostics::ScopeTimer::new("sample::read_sample");
    crate::darwin::sample(pid)
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn read_sample(_pid: u32) -> Result<Option<RawSample>, &'static str> {
    let _timer = crate::diagnostics::ScopeTimer::new("sample::read_sample");
    Err("UNSUPPORTED_PLATFORM")
}

pub fn row(pid: u32, result: Result<Option<RawSample>, &'static str>) -> Value {
    let _timer = crate::diagnostics::ScopeTimer::new("sample::row");
    match result {
        Ok(Some(value)) => json!({
            "pid": pid,
            "status": "found",
            "cpuUserMs": value.cpu_user_ms,
            "cpuSystemMs": value.cpu_system_ms,
            "cpuPercent": Value::Null,
            "rssBytes": value.rss_bytes,
            "systemPeakBytes": value.system_peak_bytes,
            "peak": value.system_peak_bytes.map(|rss_bytes| json!({
                "source": value.source,
                "rssBytes": rss_bytes,
                "windowMs": value.window_ms,
            })).unwrap_or(Value::Null),
            "unavailable": Value::Null,
        }),
        Ok(None) => json!({
            "pid": pid,
            "status": "not_found",
            "cpuUserMs": Value::Null,
            "cpuSystemMs": Value::Null,
            "cpuPercent": Value::Null,
            "rssBytes": Value::Null,
            "systemPeakBytes": Value::Null,
            "peak": Value::Null,
            "unavailable": "PROCESS_NOT_FOUND",
        }),
        Err(code) => json!({
            "pid": pid,
            "status": "error",
            "code": code,
            "cpuUserMs": Value::Null,
            "cpuSystemMs": Value::Null,
            "cpuPercent": Value::Null,
            "rssBytes": Value::Null,
            "systemPeakBytes": Value::Null,
            "peak": Value::Null,
            "unavailable": code,
        }),
    }
}

pub fn collect(pids: &[u32]) -> Vec<Value> {
    let _timer = crate::diagnostics::ScopeTimer::new("sample::collect");
    pids.iter().map(|&pid| row(pid, read_sample(pid))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(peak: Option<u64>) -> RawSample {
        RawSample {
            cpu_user_ms: 12.5,
            cpu_system_ms: 3.25,
            rss_bytes: 4096,
            system_peak_bytes: peak,
            window_ms: 7,
            source: "system",
        }
    }

    #[test]
    fn row_found_contains_full_contract() {
        let value = row(42, Ok(Some(sample(Some(8192)))));
        assert_eq!(value["pid"].as_u64(), Some(42));
        assert_eq!(value["status"].as_str(), Some("found"));
        assert_eq!(value["cpuUserMs"].as_f64(), Some(12.5));
        assert_eq!(value["cpuSystemMs"].as_f64(), Some(3.25));
        assert!(value["cpuPercent"].is_null());
        assert_eq!(value["rssBytes"].as_u64(), Some(4096));
        assert_eq!(value["systemPeakBytes"].as_u64(), Some(8192));
        assert_eq!(value["peak"]["source"].as_str(), Some("system"));
        assert_eq!(value["peak"]["rssBytes"].as_u64(), Some(8192));
        assert_eq!(value["peak"]["windowMs"].as_u64(), Some(7));
        assert!(value["unavailable"].is_null());
    }

    #[test]
    fn row_found_without_system_peak_has_null_peak() {
        let value = row(42, Ok(Some(sample(None))));
        assert!(value["systemPeakBytes"].is_null());
        assert!(value["peak"].is_null());
    }

    #[test]
    fn row_not_found_reports_unavailable() {
        let value = row(7, Ok(None));
        assert_eq!(value["pid"].as_u64(), Some(7));
        assert_eq!(value["status"].as_str(), Some("not_found"));
        assert_eq!(value["unavailable"].as_str(), Some("PROCESS_NOT_FOUND"));
        assert!(value["cpuUserMs"].is_null());
        assert!(value["rssBytes"].is_null());
    }

    #[test]
    fn row_error_exposes_code() {
        let value = row(9, Err("OPEN_PROCESS"));
        assert_eq!(value["status"].as_str(), Some("error"));
        assert_eq!(value["code"].as_str(), Some("OPEN_PROCESS"));
        assert_eq!(value["unavailable"].as_str(), Some("OPEN_PROCESS"));
    }

    #[test]
    fn collect_preserves_pid_order() {
        let values = collect(&[3, 1, 2]);
        assert_eq!(values.len(), 3);
        assert_eq!(values[0]["pid"].as_u64(), Some(3));
        assert_eq!(values[1]["pid"].as_u64(), Some(1));
        assert_eq!(values[2]["pid"].as_u64(), Some(2));
    }
}

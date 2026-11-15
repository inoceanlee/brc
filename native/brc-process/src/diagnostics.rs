//! Function and resource probes for the native process inspector.
//!
//! The probe only runs when diagnostics are enabled, so the machine-readable
//! stdout contract stays unchanged for normal callers.

use serde_json::{json, Value};
use std::cell::RefCell;
use std::time::Instant;

#[derive(Clone)]
struct Entry {
    name: &'static str,
    calls: u64,
    total_us: u128,
    max_us: u128,
}

thread_local! {
    static ENTRIES: RefCell<Vec<Entry>> = const { RefCell::new(Vec::new()) };
}

pub fn enabled() -> bool {
    matches!(
        std::env::var("BRC_DIAGNOSTICS_ENABLED").as_deref(),
        Ok("true") | Ok("1")
    )
}

pub struct ScopeTimer {
    name: &'static str,
    started: Option<Instant>,
}

impl ScopeTimer {
    pub fn new(name: &'static str) -> Self {
        Self { name, started: enabled().then(Instant::now) }
    }
}

impl Drop for ScopeTimer {
    fn drop(&mut self) {
        if let Some(started) = self.started {
            record(self.name, started.elapsed().as_micros());
        }
    }
}

pub fn record(name: &'static str, elapsed_us: u128) {
    ENTRIES.with(|entries| {
        let mut entries = entries.borrow_mut();
        if let Some(entry) = entries.iter_mut().find(|entry| entry.name == name) {
            entry.calls += 1;
            entry.total_us += elapsed_us;
            entry.max_us = entry.max_us.max(elapsed_us);
        } else {
            entries.push(Entry {
                name,
                calls: 1,
                total_us: elapsed_us,
                max_us: elapsed_us,
            });
        }
    });
}

/// Times one own function. Recursive and nested calls are reported per call,
/// matching the JavaScript aggregator semantics.
#[macro_export]
macro_rules! brc_probe {
    ($name:expr, $body:block) => {{
        if $crate::diagnostics::enabled() {
            let __brc_started = std::time::Instant::now();
            let __brc_value = $body;
            $crate::diagnostics::record($name, __brc_started.elapsed().as_micros());
            __brc_value
        } else {
            $body
        }
    }};
}

fn function_rows() -> Vec<Value> {
    ENTRIES.with(|entries| {
        entries
            .borrow()
            .iter()
            .map(|entry| {
                json!({
                    "name": entry.name,
                    "calls": entry.calls,
                    "totalMs": entry.total_us as f64 / 1000.0,
                    "maxMs": entry.max_us as f64 / 1000.0,
                    "kind": "sync",
                })
            })
            .collect()
    })
}

#[cfg(windows)]
fn resources(started: Instant) -> Value {
    use std::mem::size_of;
    use winapi::shared::minwindef::{DWORD, FILETIME};
    use winapi::um::processthreadsapi::{GetCurrentProcess, GetProcessTimes};
    use winapi::um::psapi::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};

    let mut counters: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
    counters.cb = size_of::<PROCESS_MEMORY_COUNTERS>() as DWORD;
    let memory_read = unsafe {
        GetProcessMemoryInfo(
            GetCurrentProcess(),
            &mut counters,
            counters.cb,
        )
    } != 0;
    let mut creation: FILETIME = unsafe { std::mem::zeroed() };
    let mut exit: FILETIME = unsafe { std::mem::zeroed() };
    let mut kernel: FILETIME = unsafe { std::mem::zeroed() };
    let mut user: FILETIME = unsafe { std::mem::zeroed() };
    let times_read = unsafe {
        GetProcessTimes(GetCurrentProcess(), &mut creation, &mut exit, &mut kernel, &mut user)
    } != 0;
    let to_ms = |value: &FILETIME| -> f64 {
        ((value.dwHighDateTime as u64) << 32 | value.dwLowDateTime as u64) as f64 / 10_000.0
    };
    json!({
        "schema": 1,
        "source": "native",
        "windowMs": started.elapsed().as_millis() as u64,
        "cpuUserMs": if times_read { to_ms(&user) } else { 0.0 },
        "cpuSystemMs": if times_read { to_ms(&kernel) } else { 0.0 },
        "cpuPercent": Value::Null,
        "rssBytes": if memory_read { counters.WorkingSetSize as u64 } else { 0 },
        "heapUsedBytes": Value::Null,
        "peak": if memory_read {
            json!({
                "source": "system",
                "rssBytes": counters.PeakWorkingSetSize as u64,
                "windowMs": started.elapsed().as_millis() as u64,
            })
        } else {
            Value::Null
        },
        "unavailable": if memory_read && times_read { Value::Null } else { json!("WIN32_RESOURCE_QUERY_FAILED") },
    })
}

#[cfg(not(windows))]
fn resources(started: Instant) -> Value {
    json!({
        "schema": 1,
        "source": "native",
        "windowMs": started.elapsed().as_millis() as u64,
        "cpuPercent": Value::Null,
        "peak": Value::Null,
        "unavailable": "UNSUPPORTED_PLATFORM",
    })
}

pub fn summary(started: Instant) -> Value {
    json!({
        "functions": function_rows(),
        "resources": resources(started),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_calls_and_aggregates_duration() {
        record("probe-test", 1500);
        record("probe-test", 500);
        let summary = summary(Instant::now());
        let functions = summary["functions"].as_array().expect("functions array");
        let entry = functions
            .iter()
            .find(|entry| entry["name"] == "probe-test")
            .expect("probe entry");
        assert_eq!(entry["calls"], 2);
        assert!((entry["totalMs"].as_f64().unwrap() - 2.0).abs() < f64::EPSILON);
        assert!((entry["maxMs"].as_f64().unwrap() - 1.5).abs() < f64::EPSILON);
    }
}

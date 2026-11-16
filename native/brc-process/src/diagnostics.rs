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

macro_rules! store_duration {
    ($name:expr, $elapsed:expr) => {
        ENTRIES.with(|entries| {
            let mut entries = entries.borrow_mut();
            if let Some(entry) = entries.iter_mut().find(|entry| entry.name == $name) {
                entry.calls += 1;
                entry.total_us += $elapsed;
                entry.max_us = entry.max_us.max($elapsed);
            } else {
                entries.push(Entry {
                    name: $name,
                    calls: 1,
                    total_us: $elapsed,
                    max_us: $elapsed,
                });
            }
        })
    };
}

pub fn enabled() -> bool {
    let started = Instant::now();
    let active = matches!(
        std::env::var("BRC_DIAGNOSTICS_ENABLED").as_deref(),
        Ok("true") | Ok("1")
    );
    if active {
        store_duration!("diagnostics::enabled", started.elapsed().as_micros());
    }
    active
}

pub struct ScopeTimer {
    name: &'static str,
    started: Option<Instant>,
}

impl ScopeTimer {
    pub fn new(name: &'static str) -> Self {
        let started = Instant::now();
        let active = enabled();
        let timer = Self {
            name,
            started: active.then(Instant::now),
        };
        if active {
            store_duration!("diagnostics::new", started.elapsed().as_micros());
        }
        timer
    }
}

impl Drop for ScopeTimer {
    fn drop(&mut self) {
        let started = Instant::now();
        if let Some(begin) = self.started {
            record(self.name, begin.elapsed().as_micros());
            store_duration!("diagnostics::drop", started.elapsed().as_micros());
        }
    }
}

pub fn record(name: &'static str, elapsed_us: u128) {
    let started = Instant::now();
    store_duration!(name, elapsed_us);
    store_duration!("diagnostics::record", started.elapsed().as_micros());
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
    let started = Instant::now();
    let mut rows: Vec<Value> = ENTRIES.with(|entries| {
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
    });
    record("diagnostics::function_rows", started.elapsed().as_micros());
    let own = ENTRIES
        .with(|entries| {
            entries
                .borrow()
                .iter()
                .find(|entry| entry.name == "diagnostics::function_rows")
                .cloned()
        })
        .expect("function_rows scope");
    let own_row = json!({
        "name": own.name,
        "calls": own.calls,
        "totalMs": own.total_us as f64 / 1000.0,
        "maxMs": own.max_us as f64 / 1000.0,
        "kind": "sync",
    });
    if let Some(row) = rows.iter_mut().find(|row| row["name"] == own.name) {
        *row = own_row;
    } else {
        rows.push(own_row);
    }
    rows
}

#[cfg(windows)]
fn resources(started: Instant) -> Value {
    let _timer = ScopeTimer::new("diagnostics::resources");
    use std::mem::size_of;
    use winapi::shared::minwindef::{DWORD, FILETIME};
    use winapi::um::processthreadsapi::{GetCurrentProcess, GetProcessTimes};
    use winapi::um::psapi::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};

    let mut counters: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
    counters.cb = size_of::<PROCESS_MEMORY_COUNTERS>() as DWORD;
    let memory_read =
        unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) } != 0;
    let mut creation: FILETIME = unsafe { std::mem::zeroed() };
    let mut exit: FILETIME = unsafe { std::mem::zeroed() };
    let mut kernel: FILETIME = unsafe { std::mem::zeroed() };
    let mut user: FILETIME = unsafe { std::mem::zeroed() };
    let times_read = unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    } != 0;
    let to_ms = |value: &FILETIME| -> f64 {
        ((value.dwHighDateTime as u64) << 32 | value.dwLowDateTime as u64) as f64 / 10_000.0
    };
    json!({
        "schema": 1,
        "source": "native",
        "windowMs": started.elapsed().as_millis() as u64,
        "cpuUserMs": if times_read { json!(to_ms(&user)) } else { Value::Null },
        "cpuSystemMs": if times_read { json!(to_ms(&kernel)) } else { Value::Null },
        "cpuPercent": Value::Null,
        "rssBytes": if memory_read { json!(counters.WorkingSetSize as u64) } else { Value::Null },
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
    let _timer = ScopeTimer::new("diagnostics::resources");
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
    let measured = Instant::now();
    let resource_snapshot = resources(started);
    record("diagnostics::summary", measured.elapsed().as_micros());
    json!({
        "functions": function_rows(),
        "resources": resource_snapshot,
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

    #[test]
    fn summary_reports_current_function_row_counts() {
        let payload = summary(Instant::now());
        let reported = payload["functions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == "diagnostics::function_rows")
            .expect("function_rows entry")["calls"]
            .as_u64()
            .unwrap();
        let actual = ENTRIES.with(|entries| {
            entries
                .borrow()
                .iter()
                .find(|entry| entry.name == "diagnostics::function_rows")
                .expect("recorded entry")
                .calls
        });
        assert_eq!(reported, actual);
    }
}

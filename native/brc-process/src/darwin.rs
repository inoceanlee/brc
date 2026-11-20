use crate::sample::RawSample;
use std::os::raw::{c_int, c_void};
use std::time::Instant;

extern "C" {
    fn proc_pidinfo(pid: c_int, flavor: c_int, arg: u64, buffer: *mut c_void, size: c_int) -> c_int;
}

const PROC_PIDTASKINFO: c_int = 4;

pub fn sample(pid: u32) -> Result<Option<RawSample>, &'static str> {
    let _timer = crate::diagnostics::ScopeTimer::new("darwin::sample");
    let started = Instant::now();
    let mut buffer = [0u64; 32];
    let size = (buffer.len() * std::mem::size_of::<u64>()) as c_int;
    let written = unsafe {
        proc_pidinfo(pid as c_int, PROC_PIDTASKINFO, 0, buffer.as_mut_ptr() as *mut c_void, size)
    };
    if written < 0 {
        return match std::io::Error::last_os_error().raw_os_error() {
            Some(2) | Some(3) => Ok(None),
            _ => Err("PROC_PIDINFO"),
        };
    }
    Ok(Some(RawSample {
        cpu_user_ms: buffer[2] as f64 / 1_000_000.0,
        cpu_system_ms: buffer[3] as f64 / 1_000_000.0,
        rss_bytes: buffer[1],
        system_peak_bytes: None,
        window_ms: started.elapsed().as_millis() as u64,
        source: "system",
    }))
}

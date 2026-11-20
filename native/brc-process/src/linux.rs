use crate::sample::RawSample;
use std::fs;
use std::os::raw::c_long;
use std::time::Instant;

extern "C" {
    fn sysconf(name: i32) -> c_long;
}

fn clock_ticks() -> Result<u64, &'static str> {
    let _timer = crate::diagnostics::ScopeTimer::new("linux::clock_ticks");
    const SC_CLK_TCK: i32 = 2;
    let value = unsafe { sysconf(SC_CLK_TCK) };
    if value <= 0 { Err("CLOCK_TICKS") } else { Ok(value as u64) }
}

fn parse_kb(status: &str, key: &str) -> Option<u64> {
    let _timer = crate::diagnostics::ScopeTimer::new("linux::parse_kb");
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix(key) {
            return rest.split_whitespace().next()?.parse::<u64>().ok();
        }
    }
    None
}

fn read_proc(pid: u32, suffix: &str) -> Result<Option<String>, &'static str> {
    let _timer = crate::diagnostics::ScopeTimer::new("linux::read_proc");
    let path = format!("/proc/{pid}/{suffix}");
    match fs::read_to_string(path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("PROC_READ"),
    }
}

pub fn sample(pid: u32) -> Result<Option<RawSample>, &'static str> {
    let _timer = crate::diagnostics::ScopeTimer::new("linux::sample");
    let started = Instant::now();
    let stat = match read_proc(pid, "stat")? {
        Some(value) => value,
        None => return Ok(None),
    };
    let status = match read_proc(pid, "status")? {
        Some(value) => value,
        None => return Ok(None),
    };
    let ticks_per_second = clock_ticks()?;
    let end = stat.rfind(')').ok_or("PROC_STAT_FORMAT")?;
    let rest = stat.get(end + 2..).ok_or("PROC_STAT_FORMAT")?;
    let fields: Vec<&str> = rest.split_whitespace().collect();
    let user_ticks = fields.get(11).ok_or("PROC_STAT_FORMAT")?.parse::<u64>().map_err(|_| "PROC_STAT_CPU")?;
    let system_ticks = fields.get(12).ok_or("PROC_STAT_FORMAT")?.parse::<u64>().map_err(|_| "PROC_STAT_CPU")?;
    let rss_kb = parse_kb(&status, "VmRSS").ok_or("PROC_STATUS_RSS")?;
    let peak_kb = parse_kb(&status, "VmHWM");
    let to_ms = |value: u64| -> f64 { value as f64 * 1000.0 / ticks_per_second as f64 };
    Ok(Some(RawSample {
        cpu_user_ms: to_ms(user_ticks),
        cpu_system_ms: to_ms(system_ticks),
        rss_bytes: rss_kb.saturating_mul(1024),
        system_peak_bytes: peak_kb.map(|value| value.saturating_mul(1024)),
        window_ms: started.elapsed().as_millis() as u64,
        source: "system",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_memory_fields() {
        let status = "Name:\tnode\nVmRSS:\t  4096 kB\nVmHWM:\t  8192 kB\n";
        assert_eq!(parse_kb(status, "VmRSS"), Some(4096));
        assert_eq!(parse_kb(status, "VmHWM"), Some(8192));
        assert_eq!(parse_kb(status, "VmSwap"), None);
    }
}

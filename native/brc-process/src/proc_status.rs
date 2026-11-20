pub fn memory_kb(status: &str, key: &str) -> Option<u64> {
    let _timer = crate::diagnostics::ScopeTimer::new("proc_status::memory_kb");
    let prefix = format!("{key}:");
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix(&prefix) {
            return rest.split_whitespace().next()?.parse::<u64>().ok();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_proc_status_format() {
        let status = "Name:\tnode\nState:\tS\nVmRSS:\t  4096 kB\nVmHWM:\t  8192 kB\n";
        assert_eq!(memory_kb(status, "VmRSS"), Some(4096));
        assert_eq!(memory_kb(status, "VmHWM"), Some(8192));
        assert_eq!(memory_kb(status, "VmSwap"), None);
    }
}

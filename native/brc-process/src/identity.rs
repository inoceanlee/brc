use serde_json::{Value, json};

#[derive(Clone, Debug)]
pub struct Identity {
    pub created_at: String,
    pub executable_path: String,
    pub command_line: String,
}

pub fn positive_pids(args: &[String]) -> Result<Vec<u32>, &'static str> {
    let _timer = crate::diagnostics::ScopeTimer::new("positive_pids");
    if args.is_empty() { return Err("provide at least one process ID"); }
    let mut values = Vec::new();
    for arg in args {
        if arg.is_empty() || !arg.bytes().all(|c| c.is_ascii_digit()) {
            return Err("process IDs must be positive decimal integers");
        }
        let pid = arg.parse::<u32>().map_err(|_| "process ID out of range")?;
        if pid == 0 { return Err("process ID must be positive"); }
        if !values.contains(&pid) { values.push(pid); }
    }
    Ok(values)
}

pub fn row(pid: u32, result: Result<Option<Identity>, &'static str>) -> Value {
    let _timer = crate::diagnostics::ScopeTimer::new("row");
    let value = match result {
        Ok(Some(i)) => json!({
            "pid": pid, "status": "found", "createdAt": i.created_at,
            "executablePath": i.executable_path, "commandLine": i.command_line,
        }),
        Ok(None) => json!({ "pid": pid, "status": "not_found" }),
        Err(code) => json!({ "pid": pid, "status": "error", "code": code }),
    };
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_and_deduplicates() {
        assert_eq!(positive_pids(&["2".into(), "2".into(), "3".into()]).unwrap(), [2,3]);
        for value in ["0", "-1", "10a", "4294967296", ""] {
            assert!(positive_pids(&[value.into()]).is_err());
        }
    }
}

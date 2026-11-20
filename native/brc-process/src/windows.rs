use crate::identity::{Identity, row};
use serde_json::Value;
use std::collections::HashMap;
use winapi::ctypes::c_void;
use std::ptr;
use std::slice;
use std::os::windows::ffi::OsStringExt;
use winapi::shared::minwindef::{DWORD, FALSE, ULONG, FILETIME};
use winapi::shared::wtypesbase::CLSCTX_INPROC_SERVER;
use winapi::um::combaseapi::{CoCreateInstance, CoInitializeEx, CoUninitialize, CoSetProxyBlanket};
use winapi::um::objbase::COINIT_MULTITHREADED;
use winapi::um::oleauto::{SysAllocString, SysFreeString, SysStringLen, VariantClear};
use winapi::um::wbemcli::*;
use winapi::um::processthreadsapi::{OpenProcess, GetProcessTimes, GetExitCodeProcess};
use winapi::um::psapi::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use winapi::um::winbase::QueryFullProcessImageNameW;
use winapi::um::handleapi::CloseHandle;
use winapi::um::errhandlingapi::GetLastError;
use winapi::um::winnt::{HANDLE, PROCESS_QUERY_LIMITED_INFORMATION};
use winapi::um::oaidl::VARIANT;
use winapi::um::unknwnbase::IUnknown;

const ERROR_INVALID_PARAMETER: DWORD = 87;
const STILL_ACTIVE: DWORD = 259;

struct OwnedHandle(HANDLE);
impl Drop for OwnedHandle {
    fn drop(&mut self) { let _timer = crate::diagnostics::ScopeTimer::new("windows::drop_handle"); unsafe { CloseHandle(self.0); } }
}

unsafe fn release<T>(ptr: *mut T) {
    let _timer = crate::diagnostics::ScopeTimer::new("windows::release");
    if !ptr.is_null() {
        let object = ptr as *mut IUnknown;
        ((*(*object).lpVtbl).Release)(object);
    }
}
fn wide(text: &str) -> Vec<u16> { let _timer = crate::diagnostics::ScopeTimer::new("windows::wide"); text.encode_utf16().chain(std::iter::once(0)).collect() }
unsafe fn bstr(text: &str) -> *mut u16 { let _timer = crate::diagnostics::ScopeTimer::new("windows::bstr"); SysAllocString(wide(text).as_ptr()) }
fn filetime(value: &FILETIME) -> u64 {
    let _timer = crate::diagnostics::ScopeTimer::new("windows::filetime");
    ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64
}

fn handle_identity(pid: u32) -> Result<Option<(OwnedHandle, String, String)>, &'static str> {
    let _timer = crate::diagnostics::ScopeTimer::new("windows::handle_identity");
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if handle.is_null() {
            // ERROR_INVALID_PARAMETER denotes a nonexistent PID; access denied is not absence.
            return if GetLastError() == ERROR_INVALID_PARAMETER { Ok(None) } else { Err("OPEN_PROCESS") };
        }
        let owned = OwnedHandle(handle);
        let mut code: DWORD = 0;
        if GetExitCodeProcess(handle, &mut code) == 0 { return Err("PROCESS_STATE"); }
        if code != STILL_ACTIVE { return Ok(None); }
        let mut created: FILETIME = std::mem::zeroed();
        let mut exit: FILETIME = std::mem::zeroed();
        let mut kernel: FILETIME = std::mem::zeroed();
        let mut user: FILETIME = std::mem::zeroed();
        if GetProcessTimes(handle, &mut created, &mut exit, &mut kernel, &mut user) == 0 {
            return if terminated(handle) { Ok(None) } else { Err("PROCESS_TIMES") };
        }
        let mut length: DWORD = 32768;
        let mut buffer = vec![0u16; length as usize];
        if QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length) == 0 {
            return if terminated(handle) { Ok(None) } else { Err("PROCESS_PATH") };
        }
        let path = std::ffi::OsString::from_wide(&buffer[..length as usize])
            .to_string_lossy().into_owned();
        Ok(Some((owned, filetime(&created).to_string(), path)))
    }
}
fn terminated(handle: HANDLE) -> bool {
    let _timer = crate::diagnostics::ScopeTimer::new("windows::terminated");
    unsafe {
        let mut code: DWORD = 0;
        GetExitCodeProcess(handle, &mut code) != 0 && code != STILL_ACTIVE
    }
}
fn alive_and_same(handle: HANDLE, expected: &str) -> Result<bool, &'static str> {
    let _timer = crate::diagnostics::ScopeTimer::new("windows::alive_and_same");
    unsafe {
        let mut code: DWORD = 0;
        if GetExitCodeProcess(handle, &mut code) == 0 { return Err("PROCESS_STATE"); }
        if code != STILL_ACTIVE { return Ok(false); }
        let mut created: FILETIME = std::mem::zeroed();
        let mut exit: FILETIME = std::mem::zeroed();
        let mut kernel: FILETIME = std::mem::zeroed();
        let mut user: FILETIME = std::mem::zeroed();
        if GetProcessTimes(handle, &mut created, &mut exit, &mut kernel, &mut user) == 0 {
            return Err("PROCESS_TIMES");
        }
        if filetime(&created).to_string() != expected { return Err("PROCESS_CHANGED"); }
        Ok(true)
    }
}
unsafe fn read_variant_text(object: *mut IWbemClassObject, field: &str) -> Result<Option<String>, &'static str> {
    let _timer = crate::diagnostics::ScopeTimer::new("windows::read_variant_text");
    let mut variant: VARIANT = std::mem::zeroed();
    let name = wide(field);
    let status = ((*(*object).lpVtbl).Get)(object, name.as_ptr(), 0, &mut variant, ptr::null_mut(), ptr::null_mut());
    if status < 0 { return Err("WMI_PROPERTY"); }
    let kind = *(ptr::addr_of!(variant) as *const u16);
    let result = if kind == 8 {
        let pointer = *((&variant as *const VARIANT as *const u8).add(8) as *const *mut u16);
        if pointer.is_null() { None } else {
            let length = SysStringLen(pointer) as usize;
            Some(String::from_utf16_lossy(slice::from_raw_parts(pointer, length)))
        }
    } else if kind == 1 || kind == 0 {
        None
    } else { VariantClear(&mut variant); return Err("WMI_PROPERTY_TYPE"); };
    VariantClear(&mut variant);
    Ok(result)
}
unsafe fn read_variant_pid(object: *mut IWbemClassObject) -> Result<u32, &'static str> {
    let _timer = crate::diagnostics::ScopeTimer::new("windows::read_variant_pid");
    let mut variant: VARIANT = std::mem::zeroed();
    let name = wide("ProcessId");
    let status = ((*(*object).lpVtbl).Get)(object, name.as_ptr(), 0, &mut variant, ptr::null_mut(), ptr::null_mut());
    if status < 0 { return Err("WMI_PID"); }
    let kind = *(&variant as *const VARIANT as *const u16);
    let value = if kind == 3 || kind == 19 {
        *((&variant as *const VARIANT as *const u8).add(8) as *const u32)
    } else { VariantClear(&mut variant); return Err("WMI_PID_TYPE"); };
    VariantClear(&mut variant);
    Ok(value)
}

// A single WMI query provides full Windows command lines for the whole PID batch.
fn command_lines(pids: &[u32]) -> Result<HashMap<u32, String>, &'static str> {
    let _timer = crate::diagnostics::ScopeTimer::new("windows::command_lines");
    unsafe {
        let init = CoInitializeEx(ptr::null_mut(), COINIT_MULTITHREADED);
        if init < 0 { return Err("COM_INIT"); }
        let result = query_command_lines(pids);
        CoUninitialize();
        result
    }
}
unsafe fn query_command_lines(pids: &[u32]) -> Result<HashMap<u32, String>, &'static str> {
    let _timer = crate::diagnostics::ScopeTimer::new("windows::query_command_lines");
    let mut locator: *mut IWbemLocator = ptr::null_mut();
    if CoCreateInstance(&CLSID_WbemLocator, ptr::null_mut(), CLSCTX_INPROC_SERVER, &IID_IWbemLocator, &mut locator as *mut _ as *mut *mut c_void) < 0 {
        return Err("WMI_LOCATOR");
    }
    let result = query_connected(locator, pids);
    release(locator);
    result
}
unsafe fn query_connected(locator: *mut IWbemLocator, pids: &[u32]) -> Result<HashMap<u32, String>, &'static str> {
    let _timer = crate::diagnostics::ScopeTimer::new("windows::query_connected");
    let namespace = bstr("ROOT\\CIMV2");
    let mut services: *mut IWbemServices = ptr::null_mut();
    let status = ((*(*locator).lpVtbl).ConnectServer)(
        locator, namespace, ptr::null_mut(), ptr::null_mut(), ptr::null_mut(),
        0, ptr::null_mut(), ptr::null_mut(), &mut services
    );
    SysFreeString(namespace);
    if status < 0 { return Err("WMI_CONNECT"); }
    let result = query_services(services, pids);
    release(services);
    result
}
unsafe fn query_services(services: *mut IWbemServices, pids: &[u32]) -> Result<HashMap<u32, String>, &'static str> {
    let _timer = crate::diagnostics::ScopeTimer::new("windows::query_services");
    // Use the caller's Windows identity with local WMI impersonation.
    let status = CoSetProxyBlanket(services as *mut IUnknown, 10, 0, ptr::null_mut(), 3, 3, ptr::null_mut(), 0);
    if status < 0 { return Err("WMI_PROXY"); }
    let filter = pids.iter().map(|pid| format!("ProcessId={pid}")).collect::<Vec<_>>().join(" OR ");
    let query = bstr(&format!("SELECT ProcessId, CommandLine FROM Win32_Process WHERE {filter}"));
    let language = bstr("WQL");
    let mut enumerator: *mut IEnumWbemClassObject = ptr::null_mut();
    let status = ((*(*services).lpVtbl).ExecQuery)(services, language, query, 0x30, ptr::null_mut(), &mut enumerator);
    SysFreeString(query); SysFreeString(language);
    if status < 0 { return Err("WMI_QUERY"); }
    let result = collect_enumerator(enumerator);
    release(enumerator);
    result
}
unsafe fn collect_enumerator(enumerator: *mut IEnumWbemClassObject) -> Result<HashMap<u32, String>, &'static str> {
    let _timer = crate::diagnostics::ScopeTimer::new("windows::collect_enumerator");
    let mut values = HashMap::new();
    loop {
        let mut object: *mut IWbemClassObject = ptr::null_mut();
        let mut count: ULONG = 0;
        let hr = ((*(*enumerator).lpVtbl).Next)(enumerator, 3000, 1, &mut object, &mut count);
        if count == 0 {
            if hr == 1 { break; }
            return Err("WMI_ENUMERATION");
        }
        if hr < 0 || object.is_null() { return Err("WMI_ENUMERATION"); }
        let fields = (|| {
            let pid = read_variant_pid(object)?;
            let command = read_variant_text(object, "CommandLine")?.ok_or("WMI_COMMAND_LINE")?;
            Ok::<_, &'static str>((pid, command))
        })();
        release(object);
        let (pid, command) = fields?;
        if values.insert(pid, command).is_some() { return Err("WMI_DUPLICATE"); }
    }
    Ok(values)
}

pub fn sample(pid: u32) -> Result<Option<crate::sample::RawSample>, &'static str> {
    let _timer = crate::diagnostics::ScopeTimer::new("windows::sample");
    let started = std::time::Instant::now();
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if handle.is_null() {
            return if GetLastError() == ERROR_INVALID_PARAMETER { Ok(None) } else { Err("OPEN_PROCESS") };
        }
        let _owned = OwnedHandle(handle);
        let mut code: DWORD = 0;
        if GetExitCodeProcess(handle, &mut code) == 0 { return Err("PROCESS_STATE"); }
        if code != STILL_ACTIVE { return Ok(None); }
        let mut creation: FILETIME = std::mem::zeroed();
        let mut exit: FILETIME = std::mem::zeroed();
        let mut kernel: FILETIME = std::mem::zeroed();
        let mut user: FILETIME = std::mem::zeroed();
        if GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) == 0 {
            return if terminated(handle) { Ok(None) } else { Err("PROCESS_TIMES") };
        }
        let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as DWORD;
        if GetProcessMemoryInfo(handle, &mut counters, counters.cb) == 0 {
            return Err("PROCESS_MEMORY");
        }
        Ok(Some(crate::sample::RawSample {
            cpu_user_ms: filetime(&user) as f64 / 10_000.0,
            cpu_system_ms: filetime(&kernel) as f64 / 10_000.0,
            rss_bytes: counters.WorkingSetSize as u64,
            system_peak_bytes: Some(counters.PeakWorkingSetSize as u64),
            window_ms: started.elapsed().as_millis() as u64,
            source: "system",
        }))
    }
}

pub fn inspect(pids: &[u32]) -> Vec<Value> {
    let _timer = crate::diagnostics::ScopeTimer::new("inspect");
    let entries = pids.iter().map(|pid| (*pid, handle_identity(*pid))).collect::<Vec<_>>();
    let eligible = entries.iter().filter_map(|(pid, identity)| {
        if matches!(identity, Ok(Some(_))) { Some(*pid) } else { None }
    }).collect::<Vec<_>>();
    let commands = if eligible.is_empty() { Ok(HashMap::new()) } else { command_lines(&eligible) };
    entries.into_iter().map(|(pid, value)| {
        let result = match value {
            Ok(None) => Ok(None),
            Err(code) => Err(code),
            Ok(Some((handle, created_at, executable_path))) => {
                match alive_and_same(handle.0, &created_at) {
                    Ok(false) => Ok(None),
                    Err(code) => Err(code),
                    Ok(true) => match &commands {
                        Err(code) => Err(*code),
                        Ok(commands) => match commands.get(&pid) {
                            None => Err("WMI_MISSING"),
                            Some(command_line) if command_line.is_empty() => Err("WMI_COMMAND_LINE"),
                            Some(command_line) => Ok(Some(Identity {
                                created_at, executable_path, command_line: command_line.clone(),
                            })),
                        },
                    },
                }
            },
        };
        row(pid, result)
    }).collect()
}

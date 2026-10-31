use crate::protocol::{parse_rate_limits, rate_limits_read_result, rpc_id, UsageWindows};
use serde::Serialize;
use serde_json::{json, Value};
use std::env;
use std::ffi::{OsStr, OsString};
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const EVENT_NAME: &str = "usage-state";
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const RPC_TIMEOUT: Duration = Duration::from_secs(12);
const RATE_LIMITS_RECONCILIATION_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UsageStatus {
    Connecting,
    Refreshing,
    Reconnecting,
    Stale,
    Disconnected,
    NeedsLogin,
    CliMissing,
    CliCheckFailed,
    Incompatible,
    Online,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageState {
    pub revision: u64,
    pub status: UsageStatus,
    pub five_hour: Option<crate::protocol::UsageWindow>,
    pub weekly: Option<crate::protocol::UsageWindow>,
    pub last_updated_at: Option<u64>,
}

impl Default for UsageState {
    fn default() -> Self {
        Self {
            revision: 0,
            status: UsageStatus::Connecting,
            five_hour: None,
            weekly: None,
            last_updated_at: None,
        }
    }
}

impl UsageState {
    fn has_data(&self) -> bool {
        self.last_updated_at.is_some()
    }

    fn set_windows(&mut self, windows: UsageWindows, received_at: u64) {
        self.five_hour = windows.five_hour;
        self.weekly = windows.weekly;
        self.last_updated_at = Some(received_at);
    }

    fn clear_windows(&mut self) {
        self.five_hour = None;
        self.weekly = None;
        self.last_updated_at = None;
    }
}

#[derive(Debug)]
pub enum BackendCommand {
    Shutdown(Sender<()>),
}

pub struct AppRuntime {
    pub commands: Sender<BackendCommand>,
    pub state: Arc<Mutex<UsageState>>,
}

pub fn start_backend(
    app: AppHandle,
    commands: Receiver<BackendCommand>,
    state: Arc<Mutex<UsageState>>,
) -> io::Result<()> {
    thread::Builder::new()
        .name("codex-app-server-supervisor".into())
        .spawn(move || supervise(app, commands, state))
        .map(|_| ())
}

pub fn request_backend_shutdown(commands: &Sender<BackendCommand>) {
    let (ack_tx, ack_rx) = mpsc::channel();
    if commands.send(BackendCommand::Shutdown(ack_tx)).is_ok() {
        let _ = ack_rx.recv_timeout(Duration::from_secs(2));
    }
}

#[derive(Debug, PartialEq)]
enum CliCheckFailure {
    Missing,
    CheckFailed,
}

fn classify_cli_check(result: io::Result<Vec<u8>>) -> Result<(), CliCheckFailure> {
    match result {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Err(CliCheckFailure::Missing),
        Err(_) => Err(CliCheckFailure::CheckFailed),
    }
}

fn resolve_cli(
    mut discover: impl FnMut() -> Result<CliCommand, CliCheckFailure>,
    mut on_failure: impl FnMut(CliCheckFailure),
    mut wait: impl FnMut(u64) -> bool,
) -> Option<CliCommand> {
    let mut retry_seconds = 1u64;
    loop {
        match discover() {
            Ok(cli) => return Some(cli),
            Err(failure @ CliCheckFailure::Missing) => {
                on_failure(failure);
                return None;
            }
            Err(failure) => {
                on_failure(failure);
                if wait(retry_seconds) {
                    return None;
                }
                retry_seconds = next_backoff(retry_seconds);
            }
        }
    }
}

fn report_cli_failure(app: &AppHandle, state: &Arc<Mutex<UsageState>>, failure: CliCheckFailure) {
    match failure {
        CliCheckFailure::Missing => update_status(app, state, UsageStatus::CliMissing),
        CliCheckFailure::CheckFailed => update_status(app, state, UsageStatus::CliCheckFailed),
    }
}

fn supervise(app: AppHandle, commands: Receiver<BackendCommand>, state: Arc<Mutex<UsageState>>) {
    publish(&app, &state);
    let cli = match resolve_cli(
        CliCommand::discover,
        |failure| report_cli_failure(&app, &state, failure),
        |seconds| wait_before_retry(&commands, seconds),
    ) {
        Some(cli) => cli,
        None => return,
    };

    let mut retry_seconds = 1u64;
    loop {
        match commands.try_recv() {
            Ok(BackendCommand::Shutdown(ack)) => {
                let _ = ack.send(());
                break;
            }
            Err(mpsc::TryRecvError::Disconnected) => break,
            Err(mpsc::TryRecvError::Empty) => {}
        }
        set_connecting_status(&app, &state);

        let mut connection = match cli.spawn_server() {
            Ok(connection) => connection,
            Err(_) => {
                mark_disconnected(&app, &state);
                if wait_before_retry(&commands, retry_seconds) {
                    break;
                }
                retry_seconds = next_backoff(retry_seconds);
                continue;
            }
        };

        match initialize(&mut connection, &commands) {
            Ok(()) => match run_connected(&app, &commands, &state, &mut connection) {
                LoopResult::Incompatible(_message) => {
                    update_status(&app, &state, UsageStatus::Incompatible);
                    terminate_child(&mut connection.child);
                    break;
                }
                LoopResult::Shutdown(ack) => {
                    terminate_child(&mut connection.child);
                    let _ = ack.send(());
                    break;
                }
                LoopResult::Disconnected => {
                    mark_disconnected(&app, &state);
                    retry_seconds =
                        retry_delay_after_connection(retry_seconds, connection.had_successful_read);
                }
            },
            Err(ConnectFailure::Incompatible(_message)) => {
                update_status(&app, &state, UsageStatus::Incompatible);
                terminate_child(&mut connection.child);
                break;
            }
            Err(ConnectFailure::Unavailable) => {
                mark_disconnected(&app, &state);
            }
            Err(ConnectFailure::Shutdown(ack)) => {
                terminate_child(&mut connection.child);
                let _ = ack.send(());
                break;
            }
        }

        terminate_child(&mut connection.child);
        if wait_before_retry(&commands, retry_seconds) {
            break;
        }
        retry_seconds = next_backoff(retry_seconds);
    }
}

fn next_backoff(current: u64) -> u64 {
    match current {
        0..=1 => 2,
        2..=4 => 5,
        5..=9 => 10,
        10..=29 => 30,
        _ => 60,
    }
}

fn retry_delay_after_connection(current: u64, had_successful_read: bool) -> u64 {
    if had_successful_read {
        1
    } else {
        current
    }
}

fn wait_before_retry(commands: &Receiver<BackendCommand>, seconds: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(seconds);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        match commands.recv_timeout(remaining) {
            Ok(BackendCommand::Shutdown(ack)) => {
                let _ = ack.send(());
                return true;
            }
            Err(RecvTimeoutError::Timeout) => return false,
            Err(RecvTimeoutError::Disconnected) => return true,
        }
    }
}

fn mark_disconnected(app: &AppHandle, state: &Arc<Mutex<UsageState>>) {
    if let Ok(mut snapshot) = state.lock() {
        mark_disconnected_snapshot(&mut snapshot);
    }
    publish(app, state);
}

fn mark_disconnected_snapshot(snapshot: &mut UsageState) {
    if snapshot.has_data() {
        snapshot.status = UsageStatus::Stale;
    } else {
        snapshot.status = UsageStatus::Disconnected;
    }
}

fn set_connecting_status(app: &AppHandle, state: &Arc<Mutex<UsageState>>) {
    if let Ok(mut snapshot) = state.lock() {
        if snapshot.has_data() {
            snapshot.status = UsageStatus::Reconnecting;
        } else {
            snapshot.status = UsageStatus::Connecting;
        }
    }
    publish(app, state);
}

#[derive(Debug, PartialEq)]
enum ReadErrorDisposition {
    Incompatible,
    NeedsLogin,
    Transient,
}

fn read_error_disposition(error: &Value) -> ReadErrorDisposition {
    let code = error.get("code").and_then(Value::as_i64);
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let auth_message = is_auth_message(message);
    if matches!(code, Some(-32601 | -32602)) || (code == Some(-32600) && !auth_message) {
        ReadErrorDisposition::Incompatible
    } else if matches!(code, Some(401 | 403)) || auth_message {
        ReadErrorDisposition::NeedsLogin
    } else {
        ReadErrorDisposition::Transient
    }
}

fn is_auth_message(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("authentication required") || message.contains("unauthorized")
}

fn initialize_error_is_incompatible(error: &Value) -> bool {
    read_error_disposition(error) == ReadErrorDisposition::Incompatible
}

fn parse_server_line(line: &str) -> Result<Value, ()> {
    serde_json::from_str(line).map_err(|_| ())
}

fn apply_rate_notification(
    snapshot: &mut UsageState,
    params: Option<&Value>,
    received_at: u64,
) -> bool {
    let Some(windows) = params.and_then(parse_rate_limits) else {
        snapshot.clear_windows();
        snapshot.status = UsageStatus::Refreshing;
        return true;
    };
    let complete = windows.is_complete();
    snapshot.set_windows(windows, received_at);
    if complete {
        snapshot.status = UsageStatus::Online;
    } else {
        snapshot.status = UsageStatus::Refreshing;
    }
    !complete
}

fn update_status(app: &AppHandle, state: &Arc<Mutex<UsageState>>, status: UsageStatus) {
    if let Ok(mut snapshot) = state.lock() {
        snapshot.status = status;
    }
    publish(app, state);
}

fn publish(app: &AppHandle, state: &Arc<Mutex<UsageState>>) {
    let snapshot = match state.lock() {
        Ok(mut snapshot) => {
            snapshot.revision = snapshot.revision.saturating_add(1);
            snapshot.clone()
        }
        Err(_) => return,
    };
    crate::update_tray_indicators(app, &snapshot);
    let _ = app.emit(EVENT_NAME, snapshot);
}

fn apply_windows(
    app: &AppHandle,
    state: &Arc<Mutex<UsageState>>,
    windows: UsageWindows,
    received_at: u64,
    status: UsageStatus,
) {
    if let Ok(mut snapshot) = state.lock() {
        snapshot.set_windows(windows, received_at);
        snapshot.status = status;
    }
    publish(app, state);
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn cli_candidates(path: Option<&OsStr>, app_data: Option<&OsStr>) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = path
        .map(env::split_paths)
        .into_iter()
        .flatten()
        .map(|directory| directory.join("codex.exe"))
        .collect();

    if let Some(app_data) = app_data {
        let npm_root = PathBuf::from(app_data).join("npm").join("node_modules");
        let platform_package = PathBuf::from("@openai").join("codex-win32-x64");
        candidates.push(npm_vendor_binary(
            &npm_root
                .join("@openai")
                .join("codex")
                .join("node_modules")
                .join(&platform_package),
        ));
        candidates.push(npm_vendor_binary(&npm_root.join(platform_package)));
    }

    candidates
}

fn npm_vendor_binary(package_root: &Path) -> PathBuf {
    package_root
        .join("vendor")
        .join("x86_64-pc-windows-msvc")
        .join("bin")
        .join("codex.exe")
}

fn select_cli(
    candidates: &[PathBuf],
    mut probe: impl FnMut(&Path) -> io::Result<Vec<u8>>,
) -> Result<CliCommand, CliCheckFailure> {
    let mut failure = CliCheckFailure::Missing;
    for candidate in candidates {
        match classify_cli_check(probe(candidate)) {
            Ok(()) => {
                return Ok(CliCommand {
                    program: candidate.clone().into_os_string(),
                })
            }
            Err(CliCheckFailure::CheckFailed) => failure = CliCheckFailure::CheckFailed,
            Err(CliCheckFailure::Missing) => {}
        }
    }
    Err(failure)
}

fn probe_cli(program: &Path) -> io::Result<Vec<u8>> {
    CliCommand {
        program: program.as_os_str().to_owned(),
    }
    .version()
}

#[derive(Clone, Debug)]
struct CliCommand {
    program: OsString,
}

impl CliCommand {
    fn discover() -> Result<Self, CliCheckFailure> {
        let candidates = cli_candidates(
            env::var_os("PATH").as_deref(),
            env::var_os("APPDATA").as_deref(),
        );
        select_cli(&candidates, probe_cli)
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        command
    }

    fn version(&self) -> io::Result<Vec<u8>> {
        let output = self
            .command()
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()?;
        if !output.status.success() {
            return Err(io::Error::other("Codex CLI version check failed"));
        }
        Ok(output.stdout)
    }

    fn spawn_server(&self) -> io::Result<Connection> {
        let mut child = self
            .command()
            .args(["app-server", "--listen", "stdio://"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("Codex app-server stdin unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("Codex app-server stdout unavailable"))?;
        let (server_tx, server_rx) = mpsc::channel();
        thread::Builder::new()
            .name("codex-app-server-stdout".into())
            .spawn(move || read_server_stdout(stdout, server_tx))?;
        Ok(Connection {
            child,
            stdin: BufWriter::new(stdin),
            server: server_rx,
            next_id: 1,
            pending_read: None,
            last_notification_instant: None,
            next_reconciliation_at: Instant::now(),
            had_successful_read: false,
        })
    }
}

fn read_server_stdout(stdout: ChildStdout, sender: Sender<ServerMessage>) {
    let mut reader = BufReader::new(stdout);
    let mut bytes = Vec::with_capacity(512);
    loop {
        bytes.clear();
        match read_bounded_line(&mut reader, &mut bytes) {
            Ok(0) => {
                let _ = sender.send(ServerMessage::Closed);
                return;
            }
            Ok(_) => {
                let line = match std::str::from_utf8(&bytes) {
                    Ok(line) => line.to_owned(),
                    Err(_) => {
                        let _ = sender.send(ServerMessage::InvalidEncoding);
                        return;
                    }
                };
                let _ = sender.send(ServerMessage::Line(line, Instant::now()));
            }
            Err(error) if error.kind() == io::ErrorKind::InvalidData => {
                let _ = sender.send(ServerMessage::Oversized);
                return;
            }
            Err(_) => {
                let _ = sender.send(ServerMessage::Closed);
                return;
            }
        }
    }
}

fn read_bounded_line<R: BufRead>(reader: &mut R, output: &mut Vec<u8>) -> io::Result<usize> {
    loop {
        let (take, line_complete, eof) = {
            let available = reader.fill_buf()?;
            if available.is_empty() {
                (0, false, true)
            } else if let Some(newline) = available.iter().position(|byte| *byte == b'\n') {
                (newline + 1, true, false)
            } else {
                (available.len(), false, false)
            }
        };
        if eof {
            return Ok(output.len());
        }
        if output.len().saturating_add(take) > MAX_MESSAGE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "app-server line exceeds the size limit",
            ));
        }
        {
            let available = reader.fill_buf()?;
            output.extend_from_slice(&available[..take]);
        }
        reader.consume(take);
        if line_complete {
            return Ok(output.len());
        }
    }
}

#[derive(Debug)]
enum ServerMessage {
    Line(String, Instant),
    Closed,
    Oversized,
    InvalidEncoding,
}

struct PendingRead {
    id: u64,
    started_at: Instant,
}

#[cfg(test)]
fn coalesce_read(
    pending: &mut Option<PendingRead>,
    perform_read: impl FnOnce() -> io::Result<PendingRead>,
) -> io::Result<bool> {
    if pending.is_some() {
        return Ok(false);
    }
    *pending = Some(perform_read()?);
    Ok(true)
}

struct Connection {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    server: Receiver<ServerMessage>,
    next_id: u64,
    pending_read: Option<PendingRead>,
    last_notification_instant: Option<Instant>,
    next_reconciliation_at: Instant,
    had_successful_read: bool,
}

impl Connection {
    fn send(&mut self, message: &Value) -> io::Result<()> {
        serde_json::to_writer(&mut self.stdin, message)?;
        self.stdin.write_all(b"\n")?;
        self.stdin.flush()
    }

    fn request_read(&mut self) -> io::Result<bool> {
        if self.pending_read.is_some() {
            return Ok(false);
        }
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        let started_at = Instant::now();
        self.send(&json!({ "method": "account/rateLimits/read", "id": id }))?;
        self.pending_read = Some(PendingRead { id, started_at });
        self.next_reconciliation_at = started_at + RATE_LIMITS_RECONCILIATION_INTERVAL;
        Ok(true)
    }
}

fn should_reconcile_limits(pending_read: bool, due_at: Instant, now: Instant) -> bool {
    !pending_read && now >= due_at
}

#[derive(Debug)]
enum ConnectFailure {
    Unavailable,
    Incompatible(String),
    Shutdown(Sender<()>),
}

fn initialize(
    connection: &mut Connection,
    commands: &Receiver<BackendCommand>,
) -> Result<(), ConnectFailure> {
    connection
        .send(&json!({
            "method": "initialize",
            "id": 0,
            "params": {
                "clientInfo": {
                    "name": "wimu",
                    "title": "WIMU",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        }))
        .map_err(|_| ConnectFailure::Unavailable)?;

    let deadline = Instant::now() + RPC_TIMEOUT;
    loop {
        let wait = deadline
            .saturating_duration_since(Instant::now())
            .min(Duration::from_millis(150));
        if wait.is_zero() {
            return Err(ConnectFailure::Unavailable);
        }
        match commands.try_recv() {
            Ok(BackendCommand::Shutdown(ack)) => return Err(ConnectFailure::Shutdown(ack)),
            Err(mpsc::TryRecvError::Disconnected) => return Err(ConnectFailure::Unavailable),
            Err(mpsc::TryRecvError::Empty) => {}
        }
        match connection.server.recv_timeout(wait) {
            Ok(ServerMessage::Line(line, _)) => {
                let message: Value = parse_server_line(&line).map_err(|_| {
                    ConnectFailure::Incompatible(
                        "Codex app-server devolvió un mensaje JSON inválido.".into(),
                    )
                })?;
                if rpc_id(&message) != Some(0) {
                    continue;
                }
                if let Some(error) = message.get("error") {
                    if initialize_error_is_incompatible(error) {
                        return Err(ConnectFailure::Incompatible(
                            "El protocolo de inicialización de Codex no es compatible.".into(),
                        ));
                    }
                    return Err(ConnectFailure::Unavailable);
                }
                if !message.get("result").is_some_and(Value::is_object) {
                    return Err(ConnectFailure::Incompatible(
                        "La respuesta de inicialización de Codex no tiene el formato esperado."
                            .into(),
                    ));
                }
                connection
                    .send(&json!({ "method": "initialized", "params": {} }))
                    .map_err(|_| ConnectFailure::Unavailable)?;
                return Ok(());
            }
            Ok(ServerMessage::Closed) | Err(RecvTimeoutError::Disconnected) => {
                return Err(ConnectFailure::Unavailable)
            }
            Ok(ServerMessage::Oversized) => {
                return Err(ConnectFailure::Incompatible(
                    "Codex app-server devolvió un mensaje demasiado grande.".into(),
                ))
            }
            Ok(ServerMessage::InvalidEncoding) => {
                return Err(ConnectFailure::Incompatible(
                    "Codex app-server devolvió texto que no es UTF-8 válido.".into(),
                ))
            }
            Err(RecvTimeoutError::Timeout) => {
                if Instant::now() >= deadline {
                    return Err(ConnectFailure::Unavailable);
                }
            }
        }
    }
}

enum LoopResult {
    Disconnected,
    Incompatible(String),
    Shutdown(Sender<()>),
}

fn run_connected(
    app: &AppHandle,
    commands: &Receiver<BackendCommand>,
    state: &Arc<Mutex<UsageState>>,
    connection: &mut Connection,
) -> LoopResult {
    update_status(app, state, UsageStatus::Refreshing);
    if connection.request_read().is_err() {
        return LoopResult::Disconnected;
    }

    loop {
        match commands.recv_timeout(Duration::from_millis(150)) {
            Ok(BackendCommand::Shutdown(ack)) => return LoopResult::Shutdown(ack),
            Err(RecvTimeoutError::Disconnected) => return LoopResult::Disconnected,
            Err(RecvTimeoutError::Timeout) => {}
        }

        match connection.child.try_wait() {
            Ok(Some(_)) | Err(_) => return LoopResult::Disconnected,
            Ok(None) => {}
        }
        if connection
            .pending_read
            .as_ref()
            .is_some_and(|pending| pending.started_at.elapsed() >= RPC_TIMEOUT)
        {
            return LoopResult::Disconnected;
        }

        loop {
            let message = match connection.server.try_recv() {
                Ok(message) => message,
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => return LoopResult::Disconnected,
            };
            let received = match message {
                ServerMessage::Closed => return LoopResult::Disconnected,
                ServerMessage::Oversized => {
                    return LoopResult::Incompatible(
                        "Codex app-server devolvió un mensaje demasiado grande.".into(),
                    )
                }
                ServerMessage::InvalidEncoding => {
                    return LoopResult::Incompatible(
                        "Codex app-server devolvió texto que no es UTF-8 válido.".into(),
                    )
                }
                ServerMessage::Line(line, received) => (line, received),
            };
            let parsed: Value = match parse_server_line(&received.0) {
                Ok(parsed) => parsed,
                Err(_) => {
                    return LoopResult::Incompatible(
                        "Codex app-server devolvió un mensaje JSON inválido.".into(),
                    )
                }
            };

            if parsed.get("method").and_then(Value::as_str) == Some("account/rateLimits/updated") {
                let timestamp = epoch_ms();
                connection.last_notification_instant = Some(received.1);
                connection.next_reconciliation_at =
                    received.1 + RATE_LIMITS_RECONCILIATION_INTERVAL;
                let needs_full_read = if let Ok(mut snapshot) = state.lock() {
                    apply_rate_notification(&mut snapshot, parsed.get("params"), timestamp)
                } else {
                    true
                };
                publish(app, state);
                if needs_full_read {
                    if connection.request_read().is_err() {
                        return LoopResult::Disconnected;
                    }
                }
                continue;
            }

            let response_id = rpc_id(&parsed);
            let Some(pending) = connection.pending_read.as_ref() else {
                continue;
            };
            if response_id != Some(pending.id) {
                continue;
            }
            let read_started_at = pending.started_at;
            connection.pending_read = None;

            if let Some(error) = parsed.get("error") {
                match read_error_disposition(error) {
                    ReadErrorDisposition::Incompatible => {
                        return LoopResult::Incompatible(
                            "La CLI no admite account/rateLimits/read.".into(),
                        )
                    }
                    ReadErrorDisposition::NeedsLogin => {
                        update_status(app, state, UsageStatus::NeedsLogin);
                    }
                    ReadErrorDisposition::Transient => return LoopResult::Disconnected,
                }
                continue;
            }

            if connection
                .last_notification_instant
                .is_some_and(|event_at| event_at > read_started_at)
            {
                continue;
            }

            let Some(result) = rate_limits_read_result(&parsed) else {
                return LoopResult::Incompatible(
                    "La respuesta de límites de Codex cambió de formato.".into(),
                );
            };
            let Some(windows) = parse_rate_limits(&Value::Object(result.clone())) else {
                return LoopResult::Incompatible(
                    "La respuesta de límites de Codex no contiene ventanas reconocibles.".into(),
                );
            };
            apply_windows(app, state, windows, epoch_ms(), UsageStatus::Online);
            connection.had_successful_read = true;
        }

        let reconciliation_due = should_reconcile_limits(
            connection.pending_read.is_some(),
            connection.next_reconciliation_at,
            Instant::now(),
        );
        if reconciliation_due && connection.request_read().is_err() {
            return LoopResult::Disconnected;
        }
    }
}

fn terminate_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn newer_cli_versions_are_not_blocked() {
        assert_eq!(
            classify_cli_check(Ok(b"codex-cli 0.166.0\n".to_vec())),
            Ok(())
        );
    }

    #[test]
    fn cli_check_content_does_not_decide_compatibility() {
        assert_eq!(
            classify_cli_check(Ok(b"unexpected output".to_vec())),
            Ok(())
        );
    }

    #[test]
    fn cli_check_distinguishes_missing_from_other_failures() {
        assert_eq!(
            classify_cli_check(Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "missing"
            ))),
            Err(CliCheckFailure::Missing)
        );
        assert_eq!(
            classify_cli_check(Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "denied"
            ))),
            Err(CliCheckFailure::CheckFailed)
        );
    }

    #[test]
    fn cli_candidates_prefer_path_before_npm_fallback() {
        let tools = PathBuf::from("tools");
        let app_data = PathBuf::from("appdata");
        let path = env::join_paths([&tools]).unwrap();

        let candidates = cli_candidates(Some(&path), Some(app_data.as_os_str()));

        assert_eq!(candidates.first(), Some(&tools.join("codex.exe")));
        assert!(
            candidates
                .iter()
                .skip(1)
                .all(|candidate| candidate.starts_with(app_data.join("npm"))),
            "npm fallbacks must come after every PATH candidate: {candidates:?}"
        );
    }

    #[test]
    fn falls_back_to_npm_when_path_codex_fails() {
        let candidates = vec![
            PathBuf::from("path-codex.exe"),
            PathBuf::from("npm-codex.exe"),
        ];
        let mut probed = Vec::new();

        let selected = select_cli(&candidates, |candidate| {
            probed.push(candidate.to_path_buf());
            if candidate.ends_with("path-codex.exe") {
                Err(io::Error::new(io::ErrorKind::PermissionDenied, "locked"))
            } else {
                Ok(b"codex-cli 0.166.0".to_vec())
            }
        });

        assert_eq!(
            selected.map(|cli| cli.program),
            Ok(OsString::from("npm-codex.exe"))
        );
        assert_eq!(probed, candidates);
    }

    #[test]
    fn reports_a_missing_cli_when_no_candidate_runs() {
        let candidates = vec![PathBuf::from("path-codex.exe")];

        let selected = select_cli(&candidates, |_| {
            Err(io::Error::new(io::ErrorKind::NotFound, "missing"))
        });

        assert_eq!(
            selected.map(|cli| cli.program),
            Err(CliCheckFailure::Missing)
        );
    }

    #[test]
    fn a_failed_candidate_wins_over_missing_ones() {
        let candidates = vec![PathBuf::from("locked.exe"), PathBuf::from("missing.exe")];

        let selected = select_cli(&candidates, |candidate| {
            if candidate.ends_with("locked.exe") {
                Err(io::Error::new(io::ErrorKind::PermissionDenied, "locked"))
            } else {
                Err(io::Error::new(io::ErrorKind::NotFound, "missing"))
            }
        });

        assert_eq!(
            selected.map(|cli| cli.program),
            Err(CliCheckFailure::CheckFailed)
        );
    }

    #[test]
    fn transient_cli_check_failures_are_retried_with_backoff() {
        let mut attempts = 0;
        let mut waits = Vec::new();

        let cli = resolve_cli(
            || {
                attempts += 1;
                if attempts < 3 {
                    Err(CliCheckFailure::CheckFailed)
                } else {
                    Ok(CliCommand {
                        program: OsString::from("codex.exe"),
                    })
                }
            },
            |_| {},
            |seconds| {
                waits.push(seconds);
                false
            },
        );

        assert_eq!(
            cli.map(|cli| cli.program),
            Some(OsString::from("codex.exe"))
        );
        assert_eq!(waits, vec![1, 2]);
    }

    #[test]
    fn a_missing_cli_stops_without_retrying() {
        let mut waits = Vec::new();

        let cli = resolve_cli(
            || Err(CliCheckFailure::Missing),
            |_| {},
            |seconds| {
                waits.push(seconds);
                false
            },
        );

        assert!(cli.is_none());
        assert!(waits.is_empty());
    }

    #[test]
    fn cli_retry_stops_when_shutdown_is_requested() {
        let cli = resolve_cli(|| Err(CliCheckFailure::CheckFailed), |_| {}, |_| true);

        assert!(cli.is_none());
    }

    #[test]
    fn reconnect_backoff_is_capped() {
        assert_eq!(next_backoff(1), 2);
        assert_eq!(next_backoff(2), 5);
        assert_eq!(next_backoff(10), 30);
        assert_eq!(next_backoff(30), 60);
        assert_eq!(next_backoff(60), 60);
    }

    #[test]
    fn backoff_resets_only_after_a_successful_read() {
        assert_eq!(retry_delay_after_connection(30, false), 30);
        assert_eq!(retry_delay_after_connection(30, true), 1);
    }

    #[test]
    fn limit_reconciliation_waits_until_due_and_skips_pending_reads() {
        let now = Instant::now();
        let due_at = now + Duration::from_secs(15);

        assert!(!should_reconcile_limits(false, due_at, now));
        assert!(should_reconcile_limits(false, due_at, due_at));
        assert!(!should_reconcile_limits(true, now, now));
    }

    #[test]
    fn disconnected_state_marks_cached_values_stale() {
        let mut state = UsageState {
            revision: 0,
            status: UsageStatus::Online,
            five_hour: None,
            weekly: None,
            last_updated_at: Some(1),
        };
        mark_disconnected_snapshot(&mut state);
        assert_eq!(state.status, UsageStatus::Stale);
    }

    #[test]
    fn first_disconnect_without_any_read_is_not_reported_as_stale_data() {
        let mut state = UsageState::default();
        mark_disconnected_snapshot(&mut state);
        assert_eq!(state.status, UsageStatus::Disconnected);
    }

    #[test]
    fn connecting_after_a_previous_read_is_marked_stale() {
        let mut state = UsageState {
            revision: 0,
            status: UsageStatus::Online,
            five_hour: None,
            weekly: None,
            last_updated_at: Some(1),
        };
        if state.has_data() {
            state.status = UsageStatus::Reconnecting;
        }
        assert_eq!(state.status, UsageStatus::Reconnecting);
        assert_eq!(state.last_updated_at, Some(1));
    }

    #[test]
    fn partial_notification_updates_one_window_and_requests_a_full_read() {
        let mut state = UsageState::default();
        let payload = serde_json::json!({
            "rateLimits": { "primary": { "usedPercent": 12.5, "windowDurationMins": 300, "resetsAt": 1800000000 } }
        });
        let should_read = apply_rate_notification(&mut state, Some(&payload), 1000);
        assert!(should_read);
        assert_eq!(state.status, UsageStatus::Refreshing);
        assert_eq!(state.five_hour.unwrap().remaining_percent, "87.5");
        assert!(state.weekly.is_none());
    }

    #[test]
    fn malformed_notification_clears_cached_windows_until_full_read_succeeds() {
        let mut state = UsageState {
            revision: 0,
            status: UsageStatus::Online,
            five_hour: Some(crate::protocol::UsageWindow {
                window_duration_mins: 300,
                used_percent: "39".into(),
                remaining_percent: "61".into(),
                resets_at: 1_792_000_000,
            }),
            weekly: Some(crate::protocol::UsageWindow {
                window_duration_mins: 10_080,
                used_percent: "31".into(),
                remaining_percent: "69".into(),
                resets_at: 1_792_000_000,
            }),
            last_updated_at: Some(1_000),
        };

        let should_read = apply_rate_notification(&mut state, None, 2_000);

        assert!(should_read);
        assert_eq!(state.status, UsageStatus::Refreshing);
        assert_eq!(state.five_hour, None);
        assert_eq!(state.weekly, None);
        assert_eq!(state.last_updated_at, None);
    }

    #[test]
    fn complete_notification_updates_without_a_followup_read() {
        let mut state = UsageState::default();
        let payload = serde_json::json!({
            "rateLimitsByLimitId": {
                "one": { "primary": { "usedPercent": 10, "windowDurationMins": 300, "resetsAt": 1800000000 } },
                "two": { "secondary": { "usedPercent": 40, "windowDurationMins": 10080, "resetsAt": 1800600000 } }
            }
        });
        assert!(!apply_rate_notification(&mut state, Some(&payload), 2000));
        assert_eq!(state.status, UsageStatus::Online);
        assert!(state.five_hour.is_some());
        assert!(state.weekly.is_some());
    }

    #[test]
    fn authentication_errors_are_classified_without_echoing_server_payload() {
        let auth = serde_json::json!({
            "code": -32600,
            "message": "codex account authentication required to read rate limits"
        });
        assert_eq!(
            read_error_disposition(&auth),
            ReadErrorDisposition::NeedsLogin
        );

        let unauthorized = serde_json::json!({
            "code": 401,
            "message": "unauthorized"
        });
        assert_eq!(
            read_error_disposition(&unauthorized),
            ReadErrorDisposition::NeedsLogin
        );
    }

    #[test]
    fn protocol_shape_errors_are_incompatible() {
        for code in [-32600, -32601, -32602] {
            let error = serde_json::json!({ "code": code, "message": "unsupported" });
            assert_eq!(
                read_error_disposition(&error),
                ReadErrorDisposition::Incompatible
            );
        }
    }

    #[test]
    fn internal_and_unknown_rpc_errors_are_transient() {
        for code in [-32603, -32000, -32099] {
            let error = serde_json::json!({ "code": code, "message": "temporary failure" });
            assert_eq!(
                read_error_disposition(&error),
                ReadErrorDisposition::Transient
            );
        }
        let unknown = serde_json::json!({ "message": "no code" });
        assert_eq!(
            read_error_disposition(&unknown),
            ReadErrorDisposition::Transient
        );
    }

    #[test]
    fn initialize_only_stops_on_protocol_shape_errors() {
        let method_not_found = serde_json::json!({ "code": -32601, "message": "method not found" });
        let internal = serde_json::json!({ "code": -32603, "message": "internal error" });
        let auth = serde_json::json!({
            "code": -32600,
            "message": "authentication required"
        });

        assert!(initialize_error_is_incompatible(&method_not_found));
        assert!(!initialize_error_is_incompatible(&internal));
        assert!(!initialize_error_is_incompatible(&auth));
    }

    #[test]
    fn malformed_server_message_fails_closed() {
        assert!(parse_server_line("{broken").is_err());
        assert!(parse_server_line("{\"method\":\"account/rateLimits/updated\"}").is_ok());
    }

    #[test]
    fn stdout_reader_accepts_jsonl_and_rejects_oversized_lines() {
        let mut reader = Cursor::new(b"{\"id\":1}\n".to_vec());
        let mut line = Vec::new();
        assert_eq!(read_bounded_line(&mut reader, &mut line).unwrap(), 9);
        assert_eq!(
            parse_server_line(std::str::from_utf8(&line).unwrap()).unwrap()["id"],
            1
        );

        let mut oversized = Cursor::new(vec![b'x'; MAX_MESSAGE_BYTES + 1]);
        assert_eq!(
            read_bounded_line(&mut oversized, &mut Vec::new())
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn does_not_overwrite_pending_read_on_partial_notification() {
        let started = Instant::now();
        let mut pending = Some(PendingRead {
            id: 1,
            started_at: started,
        });
        let executed = coalesce_read(&mut pending, || {
            Ok(PendingRead {
                id: 2,
                started_at: Instant::now(),
            })
        })
        .unwrap();
        assert!(!executed);
        assert_eq!(pending.as_ref().unwrap().id, 1);
        assert_eq!(pending.as_ref().unwrap().started_at, started);
    }

    #[test]
    #[ignore]
    fn real_cli_rate_limits_probe() {
        let cli = CliCommand::discover().expect("codex CLI must be installed to run real probe");
        let mut connection = cli.spawn_server().expect("app-server should spawn");
        let (command_tx, command_rx) = mpsc::channel();
        initialize(&mut connection, &command_rx).expect("initialize handshake should succeed");
        assert!(connection.request_read().is_ok());
        terminate_child(&mut connection.child);
        drop(command_tx);
    }
}

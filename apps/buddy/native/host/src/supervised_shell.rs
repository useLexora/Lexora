use std::{
    collections::BTreeMap,
    io::{self, BufRead, BufReader, Read},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use serde::Deserialize;

pub(crate) mod receipt;
pub mod recovery;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(windows)]
pub(crate) mod windows;

#[cfg(target_os = "linux")]
use linux as backend;
#[cfg(windows)]
use windows as backend;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    shell: String,
    args: Vec<String>,
    command: String,
    command_transport: Transport,
    cwd: String,
    environment: BTreeMap<String, String>,
    execution_id: Option<String>,
    dispatch_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Transport {
    Argv,
    Stdin,
}

pub fn run(configuration: Option<String>) -> io::Result<i32> {
    let launch = configuration
        .map(|value| serde_json::from_str::<receipt::Launch>(&value))
        .transpose()?;
    if let Some(launch) = &launch {
        launch.validate()?;
    }
    let supervision = backend::initialize()?;
    let mut identity = backend::identity(&supervision)?;
    let receipt = if let Some(launch) = &launch {
        identity["version"] = serde_json::json!(3);
        identity["executionId"] = serde_json::json!(launch.execution_id);
        identity["dispatchId"] = serde_json::json!(launch.dispatch_id);
        receipt::Receipt::prepare(launch, &identity)?
    } else {
        None
    };
    eprintln!(
        "{}",
        serde_json::json!({"type":"ready","protocol":if launch.is_some() {2} else {1},"identity":identity})
    );
    let mut input = BufReader::new(io::stdin());
    let mut bytes = Vec::new();
    (&mut input)
        .take(2 * 1024 * 1024 + 1)
        .read_until(b'\n', &mut bytes)?;
    if bytes.len() > 2 * 1024 * 1024 || bytes.last() != Some(&b'\n') {
        if let Some(receipt) = &receipt {
            receipt.release()?;
        }
        released();
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let request = serde_json::from_slice::<Request>(&bytes).and_then(|request| {
        if request.command.is_empty()
            || request.command.len() > 1024 * 1024
            || request.args.len() > 4096
            || request.shell.contains('\0')
            || request.cwd.contains('\0')
            || request.args.iter().any(|argument| argument.contains('\0'))
            || request
                .environment
                .iter()
                .any(|(key, value)| key.contains(['=', '\0']) || value.contains('\0'))
        {
            Err(serde::de::Error::custom("invalid shell request"))
        } else {
            Ok(request)
        }
    });
    let request = match request {
        Ok(request) => request,
        Err(error) => {
            if let Some(receipt) = &receipt {
                receipt.release()?;
            }
            released();
            return Err(error.into());
        }
    };
    if launch.as_ref().is_some_and(|launch| {
        request.execution_id.as_ref() != Some(&launch.execution_id)
            || request.dispatch_id.as_ref() != Some(&launch.dispatch_id)
    }) {
        if let Some(receipt) = &receipt {
            receipt.release()?;
        }
        released();
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancellation = Arc::clone(&cancelled);
    std::thread::spawn(move || {
        let mut byte = [0];
        let _ = input.read(&mut byte);
        cancellation.store(true, Ordering::Release);
    });
    backend::run(&supervision, &request, &cancelled, receipt.as_ref())
}

fn released() {
    eprintln!("{}", serde_json::json!({"type":"released","protocol":1}));
}

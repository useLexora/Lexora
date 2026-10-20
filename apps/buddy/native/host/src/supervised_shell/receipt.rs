use cap_std::fs::{Dir, OpenOptions};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::{self, Read, Write},
    path::Path,
};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Launch {
    pub execution_id: String,
    pub dispatch_id: String,
    pub receipt_directory: Option<String>,
}

impl Launch {
    pub(crate) fn validate(&self) -> io::Result<()> {
        if !super::recovery::valid_uuid(&self.execution_id)
            || !super::recovery::valid_uuid(&self.dispatch_id)
        {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    version: u32,
    identity: Value,
    launch_closed: bool,
}

pub(crate) struct Receipt {
    directory: Dir,
    execution_id: String,
    identity: Value,
    #[cfg(windows)]
    _guard: crate::windows_fs::ParentGuard,
}

impl Receipt {
    pub(crate) fn prepare(launch: &Launch, identity: &Value) -> io::Result<Option<Self>> {
        launch.validate()?;
        let Some(path) = &launch.receipt_directory else {
            return Ok(None);
        };
        let directory = open_directory(path, true)?;
        let receipt = Self {
            directory,
            execution_id: launch.execution_id.clone(),
            identity: identity.clone(),
            #[cfg(windows)]
            _guard: crate::windows_fs::ParentGuard::new(&Path::new(path).join("receipt"))?,
        };
        receipt.write("prepared", false)?;
        Ok(Some(receipt))
    }

    pub(crate) fn release(&self) -> io::Result<()> {
        self.write("released", true)
    }

    fn write(&self, phase: &str, launch_closed: bool) -> io::Result<()> {
        let name = format!("{}.{}.json", self.execution_id, phase);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let temporary = format!("{name}.pending");
        let mut file = self
            .directory
            .open_with(if launch_closed { &temporary } else { &name }, &options)?;
        serde_json::to_writer(
            &mut file,
            &Record {
                version: 1,
                identity: self.identity.clone(),
                launch_closed,
            },
        )?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        drop(file);
        if launch_closed {
            self.directory.rename(&temporary, &self.directory, &name)?;
        }
        #[cfg(unix)]
        self.directory.open(".")?.sync_all()?;
        Ok(())
    }
}

fn open_directory(path: &str, create: bool) -> io::Result<Dir> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt};
        if create {
            match fs::DirBuilder::new().mode(0o700).create(path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.is_dir()
            || metadata.uid() != rustix::process::geteuid().as_raw()
            || metadata.mode() & 0o077 != 0
        {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let directory = Dir::open_ambient_dir(path, cap_std::ambient_authority())?;
        let opened = directory.dir_metadata()?;
        use cap_std::fs::MetadataExt as _;
        if opened.dev() != metadata.dev() || opened.ino() != metadata.ino() {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        Ok(directory)
    }
    #[cfg(windows)]
    {
        if !create && !fs::symlink_metadata(path)?.is_dir() {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        crate::private_directories::ensure(&[path.to_string_lossy().into_owned()])
            .map_err(io::Error::other)?;
        Ok(Dir::from_std_file(crate::windows_fs::open_directory(path)?))
    }
}

pub(super) fn recover(
    root: &str,
    execution_id: &str,
    dispatch_id: &str,
) -> io::Result<(Value, bool)> {
    if !super::recovery::valid_uuid(execution_id) || !super::recovery::valid_uuid(dispatch_id) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let directory = open_directory(root, false)?;
    let prepared = read(&directory, &format!("{execution_id}.prepared.json"))?;
    if prepared.version != 1
        || prepared.launch_closed
        || prepared.identity["executionId"] != execution_id
        || prepared.identity["dispatchId"] != dispatch_id
    {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let released = match read(&directory, &format!("{execution_id}.released.json")) {
        Ok(record) => {
            if record.version != 1 || !record.launch_closed || record.identity != prepared.identity
            {
                return Err(io::ErrorKind::InvalidData.into());
            }
            true
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(error),
    };
    Ok((prepared.identity, released))
}

fn read(directory: &Dir, name: &str) -> io::Result<Record> {
    let metadata = directory.symlink_metadata(name)?;
    if !metadata.is_file() || metadata.len() > 8192 {
        return Err(io::ErrorKind::InvalidData.into());
    }
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt;
        if metadata.uid() != rustix::process::geteuid().as_raw()
            || metadata.mode() & 0o077 != 0
            || metadata.nlink() != 1
        {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
    }
    let file = directory.open(name)?;
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt;
        let opened = file.metadata()?;
        if opened.dev() != metadata.dev()
            || opened.ino() != metadata.ino()
            || opened.uid() != rustix::process::geteuid().as_raw()
            || opened.mode() & 0o077 != 0
            || opened.nlink() != 1
        {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
    }
    #[cfg(windows)]
    if crate::windows_fs::is_name_surrogate(&file)? {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let mut bytes = Vec::new();
    file.take(8193).read_to_end(&mut bytes)?;
    if bytes.len() > 8192 {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(serde_json::from_slice(&bytes)?)
}

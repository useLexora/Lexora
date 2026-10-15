use super::{
    protocol::{Error, Result},
    resources::identity,
};
use cap_std::fs::File;
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    ffi::OsStr,
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt},
    path::{Path, PathBuf},
    rc::Rc,
};
use windows::{
    Win32::{
        Foundation::E_ABORT,
        Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        },
        System::Com::{
            CLSCTX_ALL, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
            CoUninitialize,
        },
        UI::Shell::{
            FOF_NO_UI, FOF_RENAMEONCOLLISION, FOF_WANTNUKEWARNING, FOFX_ADDUNDORECORD,
            FOFX_EARLYFAILURE, FOFX_RECYCLEONDELETE, FileOperation, IFileOperation,
            IFileOperationProgressSink, IFileOperationProgressSink_Impl, IShellItem,
            SHCreateItemFromParsingName, SIGDN, SIGDN_DESKTOPABSOLUTEPARSING, SIGDN_FILESYSPATH,
            TSF_DELETE_RECYCLE_IF_POSSIBLE,
        },
    },
    core::{HRESULT, PCWSTR, Ref, implement},
};

type ShellResult<T> = windows::core::Result<T>;

fn failure() -> windows::core::Error {
    E_ABORT.into()
}

fn open_source(path: &Path, expected: &str) -> Result<File> {
    let file = File::from_std(
        std::fs::OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES.0)
            .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0 | FILE_SHARE_DELETE.0)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0 | FILE_FLAG_OPEN_REPARSE_POINT.0)
            .open(path)?,
    );
    if crate::windows_fs::is_name_surrogate(&file)? {
        return Err(Error::Unsupported);
    }
    if identity(&file.metadata()?)? != expected {
        return Err(Error::Conflict);
    }
    Ok(file)
}

fn display_name(item: &IShellItem, kind: SIGDN) -> ShellResult<String> {
    // SAFETY: The Shell owns a terminated UTF-16 allocation until CoTaskMemFree.
    unsafe {
        let name = item.GetDisplayName(kind)?;
        let value = name.to_string();
        CoTaskMemFree(Some(name.0.cast()));
        value.map_err(|_| failure())
    }
}

#[implement(IFileOperationProgressSink)]
struct Progress {
    expected: String,
    destination: Option<PathBuf>,
    receipt: Rc<RefCell<Option<Value>>>,
}

impl Progress_Impl {
    fn validate_source(&self, item: Ref<IShellItem>) -> ShellResult<()> {
        let path = display_name(item.ok()?, SIGDN_FILESYSPATH)?;
        open_source(Path::new(&path), &self.expected).map_err(|_| failure())?;
        Ok(())
    }

    fn capture(&self, item: Ref<IShellItem>, status: HRESULT) -> ShellResult<()> {
        status.ok()?;
        let item = item.ok()?;
        let path = display_name(item, SIGDN_FILESYSPATH)?;
        open_source(Path::new(&path), &self.expected).map_err(|_| failure())?;
        if let Some(destination) = &self.destination {
            if !crate::windows_fs::eq_ignore_case(&path, &destination.to_string_lossy()) {
                return Err(failure());
            }
            *self.receipt.borrow_mut() = Some(json!({}));
        } else {
            *self.receipt.borrow_mut() = Some(json!({
                "trashId": display_name(item, SIGDN_DESKTOPABSOLUTEPARSING)?,
                "trashPath": path,
                "trashIdentity": self.expected,
            }));
        }
        Ok(())
    }
}

impl IFileOperationProgressSink_Impl for Progress_Impl {
    fn PreDeleteItem(&self, flags: u32, item: Ref<IShellItem>) -> ShellResult<()> {
        if flags & TSF_DELETE_RECYCLE_IF_POSSIBLE.0 as u32 == 0 {
            return Err(failure());
        }
        self.validate_source(item)
    }
    fn PostDeleteItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        status: HRESULT,
        item: Ref<IShellItem>,
    ) -> ShellResult<()> {
        self.capture(item, status)
    }
    fn PreMoveItem(
        &self,
        _: u32,
        item: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
    ) -> ShellResult<()> {
        self.validate_source(item)?;
        if self
            .destination
            .as_ref()
            .is_some_and(|path| path.try_exists().unwrap_or(true))
        {
            return Err(failure());
        }
        Ok(())
    }
    fn PostMoveItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        status: HRESULT,
        item: Ref<IShellItem>,
    ) -> ShellResult<()> {
        self.capture(item, status)
    }
    fn StartOperations(&self) -> ShellResult<()> {
        Ok(())
    }
    fn FinishOperations(&self, status: HRESULT) -> ShellResult<()> {
        status.ok()
    }
    fn PreRenameItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR) -> ShellResult<()> {
        Err(failure())
    }
    fn PostRenameItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<IShellItem>,
    ) -> ShellResult<()> {
        Ok(())
    }
    fn PreCopyItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
    ) -> ShellResult<()> {
        Err(failure())
    }
    fn PostCopyItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<IShellItem>,
    ) -> ShellResult<()> {
        Ok(())
    }
    fn PreNewItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR) -> ShellResult<()> {
        Err(failure())
    }
    fn PostNewItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: &PCWSTR,
        _: u32,
        _: HRESULT,
        _: Ref<IShellItem>,
    ) -> ShellResult<()> {
        Ok(())
    }
    fn UpdateProgress(&self, _: u32, _: u32) -> ShellResult<()> {
        Ok(())
    }
    fn ResetTimer(&self) -> ShellResult<()> {
        Ok(())
    }
    fn PauseTimer(&self) -> ShellResult<()> {
        Ok(())
    }
    fn ResumeTimer(&self) -> ShellResult<()> {
        Ok(())
    }
}

struct Apartment;
impl Apartment {
    fn enter() -> Result<Self> {
        // SAFETY: All Shell calls stay on this worker thread and finish before uninitialization.
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() }
            .map_err(|_| Error::Recovery)?;
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        // SAFETY: A successful initialization is paired with exactly one uninitialization.
        unsafe { CoUninitialize() };
    }
}

fn perform(source: &OsStr, destination: Option<&Path>, expected: &str) -> Result<Value> {
    let destination = destination.map(|path| path.components().collect::<PathBuf>());
    let destination = destination.as_deref();
    let _apartment = Apartment::enter()?;
    let receipt = Rc::new(RefCell::new(None));
    let sink: IFileOperationProgressSink = Progress {
        expected: expected.into(),
        destination: destination.map(Path::to_path_buf),
        receipt: receipt.clone(),
    }
    .into();
    let wide = |path: &OsStr| path.encode_wide().chain(Some(0)).collect::<Vec<_>>();
    let source = wide(source);
    // SAFETY: COM objects and UTF-16 buffers remain live through the synchronous operation.
    unsafe {
        let operation: IFileOperation =
            CoCreateInstance(&FileOperation, None, CLSCTX_ALL).map_err(|_| Error::Recovery)?;
        let flags = FOF_NO_UI
            | FOFX_EARLYFAILURE
            | if destination.is_some() {
                FOF_RENAMEONCOLLISION
            } else {
                FOFX_RECYCLEONDELETE | FOFX_ADDUNDORECORD | FOF_WANTNUKEWARNING
            };
        operation
            .SetOperationFlags(flags)
            .map_err(|_| Error::Recovery)?;
        let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(source.as_ptr()), None)
            .map_err(|_| Error::Recovery)?;
        if let Some(destination) = destination {
            let parent = wide(destination.parent().ok_or(Error::Invalid)?.as_os_str());
            let name = wide(destination.file_name().ok_or(Error::Invalid)?);
            let folder: IShellItem = SHCreateItemFromParsingName(PCWSTR(parent.as_ptr()), None)
                .map_err(|_| Error::Recovery)?;
            operation
                .MoveItem(&item, &folder, PCWSTR(name.as_ptr()), &sink)
                .map_err(|_| Error::Recovery)?;
        } else {
            operation
                .DeleteItem(&item, &sink)
                .map_err(|_| Error::Recovery)?;
        }
        operation.PerformOperations().map_err(|_| Error::Recovery)?;
        if operation
            .GetAnyOperationsAborted()
            .map_err(|_| Error::Recovery)?
            .as_bool()
        {
            return Err(Error::Recovery);
        }
    }
    receipt.borrow_mut().take().ok_or(Error::Recovery)
}

pub fn trash(path: &Path, expected: &str) -> Result<Value> {
    let _source = open_source(path, expected)?;
    let path: PathBuf = path.components().collect();
    perform(path.as_os_str(), None, expected)
}

pub fn restore(receipt: &Value, destination: &Path) -> Result<()> {
    let expected = receipt["sourceIdentity"].as_str().ok_or(Error::Invalid)?;
    let path = Path::new(receipt["trashPath"].as_str().ok_or(Error::Invalid)?);
    let _source = open_source(path, expected)?;
    let _parents = crate::windows_fs::ParentGuard::new(path)?;
    let id = receipt["trashId"].as_str().ok_or(Error::Invalid)?;
    perform(OsStr::new(id), Some(destination), expected)?;
    Ok(())
}

pub fn validate_trash_path(path: &Path) -> Result<()> {
    use windows_sys::Win32::{
        Storage::FileSystem::{GetDriveTypeW, GetVolumePathNameW},
        System::WindowsProgramming::DRIVE_FIXED,
    };
    let path: PathBuf = path.components().collect();
    let path = crate::windows_fs::extended_path(&path)?;
    let mut volume = vec![0u16; 32768];
    // SAFETY: The input is terminated, the output buffer is writable, and GetDriveTypeW runs only after successful initialization.
    unsafe {
        if GetVolumePathNameW(path.as_ptr(), volume.as_mut_ptr(), volume.len() as u32) == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        if GetDriveTypeW(volume.as_ptr()) != DRIVE_FIXED {
            return Err(Error::Unsupported);
        }
    }
    Ok(())
}

use super::{
    protocol::{Error, Result},
    resources::Root,
};
use serde_json::Value;
#[cfg(not(windows))]
use serde_json::json;
use std::path::Path;

#[cfg(target_os = "linux")]
pub fn trash(path: &Path, _expected: &str) -> Result<Value> {
    let before = trash::os_limited::list().map_err(|_| Error::Recovery)?;
    trash::delete(path).map_err(|_| Error::Recovery)?;
    let mut found = trash::os_limited::list()
        .map_err(|_| Error::Recovery)?
        .into_iter()
        .filter(|item| item.original_path() == path && !before.iter().any(|old| old.id == item.id));
    let item = found.next().ok_or(Error::Recovery)?;
    if found.next().is_some() {
        return Err(Error::Recovery);
    }
    let receipt = json!({ "trashId": item.id.to_str().ok_or(Error::Unsupported)?, "name": item.name.to_str().ok_or(Error::Unsupported)?, "originalParent": item.original_parent, "timeDeleted": item.time_deleted });
    #[cfg(target_os = "linux")]
    let receipt = {
        let mut receipt = receipt;
        let info = Path::new(&item.id);
        let payload = info
            .parent()
            .and_then(Path::parent)
            .ok_or(Error::Unsupported)?
            .join("files")
            .join(info.file_stem().ok_or(Error::Unsupported)?);
        let dir = cap_std::fs::Dir::open_ambient_dir(
            payload.parent().ok_or(Error::Invalid)?,
            cap_std::ambient_authority(),
        )?;
        receipt["trashPath"] = json!(payload);
        receipt["trashIdentity"] = json!(super::resources::identity(
            &dir.symlink_metadata(payload.file_name().ok_or(Error::Invalid)?)?
        )?);
        receipt
    };
    Ok(receipt)
}

#[cfg(windows)]
pub fn trash(path: &Path, expected: &str) -> Result<Value> {
    super::windows_shell::trash(path, expected)
}

#[cfg(target_os = "macos")]
pub fn trash(path: &Path, _expected: &str) -> Result<Value> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let url = NSURL::fileURLWithPath(&NSString::from_str(
        path.to_str().ok_or(Error::Unsupported)?,
    ));
    let mut destination = None;
    NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, Some(&mut destination))
        .map_err(|_| Error::Recovery)?;
    let path = destination
        .and_then(|url| url.path())
        .ok_or(Error::Recovery)?
        .to_string();
    let path = Path::new(&path);
    let dir = cap_std::fs::Dir::open_ambient_dir(
        path.parent().ok_or(Error::Invalid)?,
        cap_std::ambient_authority(),
    )?;
    let identity = super::resources::identity(
        &dir.symlink_metadata(path.file_name().ok_or(Error::Invalid)?)?,
    )?;
    Ok(json!({ "trashPath": path, "trashIdentity": identity }))
}

pub fn restore(root: &Root, path: &str, receipt: &Value) -> Result<()> {
    let destination = root.resolve(path)?;
    if destination.try_exists()? {
        return Err(Error::Conflict);
    }
    root.check()?;
    #[cfg(windows)]
    {
        super::windows_shell::restore(receipt, &destination)?;
        root.check()?;
        let identity = super::resources::identity(&root.dir.symlink_metadata(path)?)?;
        if receipt["sourceIdentity"].as_str() != Some(identity.as_str()) {
            return Err(Error::Recovery);
        }
        Ok(())
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        use cap_std::fs::Dir;
        let source = Path::new(receipt["trashPath"].as_str().ok_or(Error::Unsupported)?);
        let from = Dir::open_ambient_dir(
            source.parent().ok_or(Error::Invalid)?,
            cap_std::ambient_authority(),
        )?;
        let identity = super::resources::identity(
            &from.symlink_metadata(source.file_name().ok_or(Error::Invalid)?)?,
        )?;
        if receipt["trashIdentity"].as_str() != Some(identity.as_str()) {
            return Err(Error::Conflict);
        }
        let relative = super::resources::relative(path)?;
        let to = root.dir.open_dir(
            relative
                .parent()
                .filter(|path| !path.as_os_str().is_empty())
                .unwrap_or(Path::new(".")),
        )?;
        super::io::rename_new(
            &from,
            Path::new(source.file_name().ok_or(Error::Invalid)?),
            &to,
            Path::new(relative.file_name().ok_or(Error::Invalid)?),
        )?;
        super::io::sync_dir(&to)?;
        super::io::sync_dir(&from)?;
        #[cfg(target_os = "linux")]
        if let Some(info) = receipt["trashId"].as_str() {
            let info = Path::new(info);
            if info.parent().and_then(Path::parent) == source.parent().and_then(Path::parent) {
                std::fs::remove_file(info)?;
            }
        }
        Ok(())
    }
}

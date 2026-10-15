use super::protocol::{ClaimInput, Error, Result};
#[cfg(windows)]
use cap_primitives::fs::_WindowsByHandle;
#[cfg(unix)]
use cap_std::fs::MetadataExt;
use cap_std::fs::{Dir, Metadata};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

pub struct Root {
    pub path: PathBuf,
    pub dir: Dir,
    pub identity: String,
    pub revoked: Arc<AtomicBool>,
}

impl Root {
    pub fn check(&self) -> Result<()> {
        if self.revoked.load(Ordering::SeqCst) {
            return Err(Error::Revoked);
        }
        let current = Dir::open_ambient_dir(&self.path, cap_std::ambient_authority())?;
        if identity(&current.dir_metadata()?)? != self.identity {
            return Err(Error::Revoked);
        }
        Ok(())
    }

    pub fn resolve(&self, path: &str) -> Result<PathBuf> {
        self.check()?;
        let relative = relative(path)?;
        let mut prefix = PathBuf::new();
        for component in relative.components() {
            prefix.push(component);
            match self.dir.symlink_metadata(&prefix) {
                Ok(metadata) if metadata.is_symlink() => return Err(Error::Unsupported),
                Ok(_) => (),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                Err(error) => return Err(error.into()),
            }
        }
        if relative.as_os_str().is_empty() {
            return Ok(self.path.clone());
        }
        let mut parent = relative.parent().ok_or(Error::Invalid)?;
        loop {
            match self.dir.canonicalize(if parent.as_os_str().is_empty() {
                Path::new(".")
            } else {
                parent
            }) {
                Ok(canonical) => {
                    return Ok(self
                        .path
                        .join(canonical)
                        .join(relative.strip_prefix(parent).map_err(|_| Error::Invalid)?));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    parent = parent.parent().ok_or(error)?
                }
                Err(error) => return Err(error.into()),
            }
        }
    }

    pub fn claim(&self, path: &str, subtree: bool) -> Result<Claim> {
        let resolved = self.resolve(path)?;
        let object = match self
            .dir
            .symlink_metadata(if path.is_empty() { "." } else { path })
        {
            Ok(metadata) => Some(identity(&metadata)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        Ok(Claim {
            path: path_key(&resolved),
            subtree,
            object,
        })
    }
}

#[derive(Default)]
pub struct Roots(pub HashMap<String, Arc<Root>>);

impl Roots {
    pub fn register(
        &mut self,
        key: String,
        path: String,
        revoked: Arc<AtomicBool>,
    ) -> Result<Arc<Root>> {
        if key.is_empty() || key.len() > 512 || !Path::new(&path).is_absolute() {
            return Err(Error::Invalid);
        }
        let canonical = public_path(std::fs::canonicalize(&path)?);
        let dir = Dir::open_ambient_dir(&canonical, cap_std::ambient_authority())?;
        let identity = identity(&dir.dir_metadata()?)?;
        if let Some(previous) = self.0.get(&key) {
            if previous.path != canonical || previous.identity != identity {
                return Err(Error::Revoked);
            }
            previous.check()?;
            return Ok(previous.clone());
        }
        let root = Arc::new(Root {
            path: canonical,
            dir,
            identity,
            revoked,
        });
        self.0.insert(key, root.clone());
        Ok(root)
    }

    pub fn get(&self, key: &str) -> Result<Arc<Root>> {
        let root = self.0.get(key).ok_or(Error::Revoked)?.clone();
        root.check()?;
        Ok(root)
    }

    pub fn claims(&self, inputs: &[ClaimInput]) -> Result<Vec<Claim>> {
        if inputs.len() > 128 {
            return Err(Error::Invalid);
        }
        inputs
            .iter()
            .map(|input| {
                if input.root == "*" {
                    return Ok(Claim {
                        path: "*".into(),
                        subtree: true,
                        object: None,
                    });
                }
                self.get(&input.root)?.claim(&input.path, input.subtree)
            })
            .collect()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Claim {
    pub path: String,
    pub subtree: bool,
    pub object: Option<String>,
}

pub fn overlap(left: &[Claim], right: &[Claim]) -> bool {
    left.iter().any(|a| {
        right.iter().any(|b| {
            a.path == "*"
                || b.path == "*"
                || a.path == b.path
                || (a.object.is_some() && a.object == b.object)
                || (a.subtree && contains(&a.path, &b.path))
                || (b.subtree && contains(&b.path, &a.path))
        })
    })
}

pub fn contains(parent: &str, child: &str) -> bool {
    child == parent
        || child
            .strip_prefix(parent)
            .is_some_and(|suffix| parent.ends_with('/') || suffix.starts_with('/'))
}

pub fn path_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

pub fn relative(path: &str) -> Result<PathBuf> {
    if path.len() > 4096
        || path.contains(['\0', '\\'])
        || Path::new(path).is_absolute()
        || path.split('/').any(|part| part == ".." || part == ".")
    {
        return Err(Error::Invalid);
    }
    let result = PathBuf::from(path);
    if result
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(Error::Invalid);
    }
    #[cfg(windows)]
    for part in path.split('/').filter(|part| !part.is_empty()) {
        if !crate::windows_path::valid_component(part) {
            return Err(Error::Invalid);
        }
    }
    Ok(result)
}

pub fn identity(metadata: &Metadata) -> Result<String> {
    #[cfg(unix)]
    return Ok(format!("{}:{}", metadata.dev(), metadata.ino()));
    #[cfg(windows)]
    return Ok(format!(
        "{}:{}",
        metadata.volume_serial_number().ok_or(Error::Unsupported)?,
        metadata.file_index().ok_or(Error::Unsupported)?
    ));
    #[cfg(not(any(unix, windows)))]
    Err(Error::Unsupported)
}

fn public_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        if let Some(local) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(local);
        }
    }
    path
}

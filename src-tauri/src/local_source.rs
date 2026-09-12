use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Clone, Default)]
pub struct LocalSourceRegistry {
    inner: Arc<Mutex<LocalSourceState>>,
}

#[derive(Default)]
struct LocalSourceState {
    next_id: u64,
    paths: HashMap<String, PathBuf>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RegisteredLocalSource {
    pub source_id: String,
    pub locator: String,
    pub display_name: String,
}

#[derive(Debug, Eq, PartialEq)]
pub enum LocalSourceError {
    InvalidDirectory,
    Unavailable(String),
    RegistryPoisoned,
}

impl std::fmt::Display for LocalSourceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidDirectory => formatter.write_str("selected source is not a directory"),
            Self::Unavailable(locator) => write!(formatter, "source is not registered: {locator}"),
            Self::RegistryPoisoned => formatter.write_str("local source registry lock poisoned"),
        }
    }
}

impl std::error::Error for LocalSourceError {}

impl LocalSourceRegistry {
    pub fn register(
        &self,
        path: impl AsRef<Path>,
    ) -> Result<RegisteredLocalSource, LocalSourceError> {
        let path = path.as_ref();
        if !path.is_dir() {
            return Err(LocalSourceError::InvalidDirectory);
        }

        let canonical = fs::canonicalize(path).map_err(|_| LocalSourceError::InvalidDirectory)?;
        let display_name = canonical
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("Selected folder")
            .to_owned();

        let mut state = self
            .inner
            .lock()
            .map_err(|_| LocalSourceError::RegistryPoisoned)?;
        let id = state.next_id;
        state.next_id = state.next_id.wrapping_add(1);

        let locator = format!("local-source/{id}");
        let source_id = format!("local-{id}");
        state.paths.insert(locator.clone(), canonical);

        Ok(RegisteredLocalSource {
            source_id,
            locator,
            display_name,
        })
    }

    pub fn resolve(&self, locator: &str) -> Result<PathBuf, LocalSourceError> {
        if locator.trim().is_empty() {
            return Err(LocalSourceError::Unavailable(locator.to_owned()));
        }

        let state = self
            .inner
            .lock()
            .map_err(|_| LocalSourceError::RegistryPoisoned)?;
        state
            .paths
            .get(locator)
            .cloned()
            .ok_or_else(|| LocalSourceError::Unavailable(locator.to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn registers_and_resolves_directories_without_exposing_paths_as_locators() {
        let dir = tempdir().unwrap();
        let registry = LocalSourceRegistry::default();

        let source = registry.register(dir.path()).unwrap();

        assert!(source.source_id.starts_with("local-"));
        assert!(source.locator.starts_with("local-source/"));
        assert!(!source.locator.contains(&dir.path().to_string_lossy().to_string()));
        assert_eq!(registry.resolve(&source.locator).unwrap(), fs::canonicalize(dir.path()).unwrap());
    }

    #[test]
    fn rejects_unknown_locators_and_non_directories() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("media.jpg");
        fs::write(&file, b"not an image").unwrap();
        let registry = LocalSourceRegistry::default();

        assert!(matches!(
            registry.register(&file),
            Err(LocalSourceError::InvalidDirectory)
        ));
        assert!(matches!(
            registry.resolve("local-source/999"),
            Err(LocalSourceError::Unavailable(_))
        ));
    }
}

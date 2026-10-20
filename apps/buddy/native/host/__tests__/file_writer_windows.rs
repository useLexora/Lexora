use super::{WriteError, replacement_failure};
use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION,
    ERROR_UNABLE_TO_MOVE_REPLACEMENT, ERROR_UNABLE_TO_MOVE_REPLACEMENT_2,
    ERROR_UNABLE_TO_REMOVE_REPLACED, ERROR_WRITE_PROTECT,
};

#[test]
fn replacement_rejections_are_distinct_from_unconfirmed_commits() {
    for code in [
        ERROR_ACCESS_DENIED,
        ERROR_LOCK_VIOLATION,
        ERROR_SHARING_VIOLATION,
        ERROR_WRITE_PROTECT,
    ] {
        assert!(
            matches!(replacement_failure(code), WriteError::Failed),
            "{code}"
        );
    }
    for code in [
        ERROR_UNABLE_TO_MOVE_REPLACEMENT,
        ERROR_UNABLE_TO_MOVE_REPLACEMENT_2,
        ERROR_UNABLE_TO_REMOVE_REPLACED,
        0,
        u32::MAX,
    ] {
        assert!(
            matches!(replacement_failure(code), WriteError::OutcomeUnknown),
            "{code}"
        );
    }
}

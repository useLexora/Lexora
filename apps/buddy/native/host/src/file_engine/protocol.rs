use serde::{Deserialize, Serialize};

pub const VERSION: u32 = 1;
pub const MAX_FRAME: usize = 128 * 1024 * 1024;
pub const MAX_TEXT: usize = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub id: u64,
    pub command: Command,
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Command {
    Register {
        key: String,
        path: String,
        #[serde(default)]
        watch: bool,
    },
    Revoke {
        key: String,
    },
    List {
        root: String,
        path: String,
        cursor: Option<String>,
    },
    Read {
        root: String,
        path: String,
    },
    Acquire {
        lease_id: String,
        claims: Vec<ClaimInput>,
        external: bool,
    },
    Release {
        lease_id: String,
        hazard: bool,
    },
    Mutate {
        request: Mutation,
    },
    Query {
        operation_id: String,
    },
    History {
        root: String,
    },
    Acknowledge {
        operation_id: String,
    },
    Cancel {
        operation_id: String,
    },
    Leases,
    Shutdown,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimInput {
    pub root: String,
    pub path: String,
    pub subtree: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mutation {
    pub operation_id: String,
    pub root: String,
    pub path: String,
    pub lease_id: Option<String>,
    pub action: Action,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Action {
    Write {
        text: String,
        expected: Option<String>,
    },
    CreateFile,
    CreateDirectory,
    Rename {
        destination: String,
    },
    Copy {
        destination_root: String,
        destination: String,
    },
    Move {
        destination_root: String,
        destination: String,
    },
    Trash,
    Restore {
        original_operation_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Prepared,
    Executing,
    Applied,
    NotApplied,
    NeedsRecovery,
    Acknowledged,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub operation_id: String,
    pub kind: String,
    pub source: String,
    pub destination: Option<String>,
    pub status: Status,
    pub error: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub receipt: Option<serde_json::Value>,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("FILE_INVALID_REQUEST")]
    Invalid,
    #[error("FILE_PERMISSION_REVOKED")]
    Revoked,
    #[error("FILE_CONFLICT")]
    Conflict,
    #[error("FILE_OPERATION_CANCELLED")]
    Cancelled,
    #[error("FILE_RECOVERY_REQUIRED")]
    Recovery,
    #[error("FILE_LEASE_INVALID")]
    Lease,
    #[error("FILE_OPERATION_ID_CONFLICT")]
    IdConflict,
    #[error("FILE_UNSUPPORTED")]
    Unsupported,
    #[error("FILE_IO_FAILED")]
    Io(#[from] std::io::Error),
    #[error("FILE_JOURNAL_FAILED")]
    Journal(#[from] rusqlite::Error),
    #[error("FILE_PROTOCOL_FAILED")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

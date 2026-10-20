use super::{
    protocol::{Error, Operation, Result, Status},
    resources::{Claim, path_key},
};
use rusqlite::{Connection, OptionalExtension, params};
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

pub struct Journal(Connection);

impl Journal {
    pub fn open(directory: &Path) -> Result<Self> {
        std::fs::create_dir_all(directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
        }
        let connection = Connection::open(directory.join("operations.sqlite"))?;
        connection.execute_batch(
            "PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE; COMMIT;",
        )?;
        let version: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > 2 {
            return Err(Error::Invalid);
        }
        connection.execute_batch("CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, record TEXT NOT NULL, claims TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL, destination TEXT); CREATE INDEX IF NOT EXISTS operations_source ON operations(source); CREATE INDEX IF NOT EXISTS operations_destination ON operations(destination); CREATE INDEX IF NOT EXISTS operations_status ON operations(status); CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, claims TEXT NOT NULL, hazard INTEGER NOT NULL DEFAULT 0, external INTEGER NOT NULL); PRAGMA user_version=2;")?;
        let mut journal = Self(connection);
        for mut record in journal.records(
            "SELECT record FROM operations WHERE status IN ('\"prepared\"','\"executing\"')",
            [],
        )? {
            if matches!(record.status, Status::Prepared | Status::Executing) {
                record.status = if record.status == Status::Prepared {
                    Status::NotApplied
                } else {
                    Status::NeedsRecovery
                };
                record.error = Some("FILE_OPERATION_INTERRUPTED".into());
                journal.update(&mut record)?;
            }
        }
        journal
            .0
            .execute_batch("DELETE FROM leases WHERE external=0; UPDATE leases SET hazard=1")?;
        Ok(journal)
    }

    pub fn find(&self, id: &str) -> Result<Option<(String, Operation)>> {
        let row: Option<(String, String)> = self
            .0
            .query_row(
                "SELECT fingerprint, record FROM operations WHERE id=?",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        row.map(|(fingerprint, record)| Ok((fingerprint, serde_json::from_str(&record)?)))
            .transpose()
    }

    pub fn prepare(&self, fingerprint: &str, record: &Operation, claims: &[Claim]) -> Result<()> {
        self.0.execute(
            "INSERT INTO operations(id,fingerprint,record,claims,status,source,destination) VALUES (?,?,?,?,?,?,?)",
            params![
                record.operation_id,
                fingerprint,
                serde_json::to_string(record)?,
                serde_json::to_string(claims)?,
                serde_json::to_string(&record.status)?,
                path_key(Path::new(&record.source)),
                record.destination.as_ref().map(|path| path_key(Path::new(path)))
            ],
        )?;
        Ok(())
    }

    pub fn update(&mut self, record: &mut Operation) -> Result<()> {
        record.updated_at = now();
        if self.0.execute(
            "UPDATE operations SET record=?,status=? WHERE id=?",
            params![
                serde_json::to_string(record)?,
                serde_json::to_string(&record.status)?,
                record.operation_id
            ],
        )? != 1
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }

    pub fn history(&self, root: &str) -> Result<Vec<Operation>> {
        let prefix = format!("{}/", root.trim_end_matches('/'));
        self.records("SELECT record FROM operations WHERE source=?1 OR destination=?1 OR (source>=?2 AND source<?3) OR (destination>=?2 AND destination<?3) ORDER BY status='\"needs-recovery\"' DESC,rowid DESC LIMIT 200", params![root, prefix, format!("{prefix}\u{10ffff}")])
    }

    fn records(&self, sql: &str, params: impl rusqlite::Params) -> Result<Vec<Operation>> {
        let mut query = self.0.prepare(sql)?;
        let rows = query.query_map(params, |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }

    pub fn leases(&self) -> Result<Vec<(String, Vec<Claim>, bool)>> {
        let mut query = self.0.prepare("SELECT id, claims, hazard FROM leases")?;
        let rows = query.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get(2)?,
            ))
        })?;
        rows.map(|row| {
            let (id, claims, hazard) = row?;
            Ok((id, serde_json::from_str(&claims)?, hazard))
        })
        .collect()
    }

    pub fn acquire(&self, id: &str, claims: &[Claim], external: bool) -> Result<()> {
        self.0.execute(
            "INSERT INTO leases(id,claims,external) VALUES (?,?,?)",
            params![id, serde_json::to_string(claims)?, external],
        )?;
        Ok(())
    }

    pub fn protect(&self, id: &str, claims: &[Claim]) -> Result<()> {
        let existing: Option<String> = self
            .0
            .query_row("SELECT claims FROM leases WHERE id=?", [id], |row| {
                row.get(0)
            })
            .optional()?;
        let mut merged: Vec<Claim> = existing
            .map(|value| serde_json::from_str(&value))
            .transpose()?
            .unwrap_or_default();
        for claim in claims {
            if !merged.contains(claim) {
                merged.push(claim.clone());
            }
        }
        self.0.execute(
            "INSERT INTO leases(id,claims,external,hazard) VALUES (?,?,1,1) ON CONFLICT(id) DO UPDATE SET claims=excluded.claims,external=1,hazard=1",
            params![id, serde_json::to_string(&merged)?],
        )?;
        Ok(())
    }

    pub fn release(&self, id: &str, hazard: bool) -> Result<()> {
        if hazard {
            self.0
                .execute("UPDATE leases SET hazard=1 WHERE id=?", [id])?;
        } else {
            self.0.execute("DELETE FROM leases WHERE id=?", [id])?;
        }
        Ok(())
    }
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |value| value.as_millis() as u64)
}

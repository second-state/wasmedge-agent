//! Continual-harness state CRUD (DESIGN.md §4.3), the rust port of the
//! kernel-era `rlm.harness`. State lives in `harness_state.json` under the
//! preopened `/agent/harness` (local) and `/agent/harness-global` dirs; the
//! host `/refine` command rewrites the same files, so every operation first
//! re-syncs when the on-disk mtime moved (out-of-process write detection —
//! without it a stale in-cell save would clobber host edits).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::SystemTime;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{Error, ErrorKind};

pub const KINDS: [&str; 4] = ["prompt", "memory", "skill", "subagent"];

const LOCAL_DIR: &str = "/agent/harness";
const GLOBAL_DIR: &str = "/agent/harness-global";
const FILE_NAME: &str = "harness_state.json";

fn state_err(message: impl Into<String>) -> anyhow::Error {
    Error::new(ErrorKind::State, message.into()).into()
}

/// One reusable prompt note, memory, skill, or subagent record. Field names
/// match the host `harness_state.json` schema exactly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub content: String,
    #[serde(default = "default_path")]
    pub path: String,
    #[serde(default = "default_scope")]
    pub scope: String,
    #[serde(default = "empty_object")]
    pub reference: Value,
    #[serde(default = "empty_object")]
    pub arguments: Value,
    #[serde(default = "empty_object")]
    pub metadata: Value,
    #[serde(default = "default_source")]
    pub source: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default = "default_version")]
    pub version: u64,
}

/// A recorded refinement pass.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefinementEvent {
    pub id: String,
    pub trigger: String,
    #[serde(default)]
    pub changes: Vec<String>,
    #[serde(default)]
    pub evidence: String,
    #[serde(default)]
    pub outcome: String,
    #[serde(default)]
    pub created_at: String,
}

fn default_path() -> String {
    "general".to_string()
}
fn default_scope() -> String {
    "local".to_string()
}
fn default_source() -> String {
    "agent".to_string()
}
fn default_version() -> u64 {
    1
}
fn empty_object() -> Value {
    json!({})
}

/// Skill entries must carry a rust reference (DESIGN.md §4.3): the mounted
/// crate path plus how to call it. Kernel-era python references stay readable
/// but cannot be created. Kept in sync with the host validator in
/// `refinement.ts`.
pub fn validate_rust_skill_reference(reference: &Value) -> Result<()> {
    let obj = reference
        .as_object()
        .ok_or_else(|| state_err("skill entries require a rust reference object"))?;
    match obj.get("type").and_then(Value::as_str) {
        Some("rust") => {}
        Some("python") => {
            return Err(state_err(
                "python skill references are legacy (read-only); create rust skills with type \"rust\"",
            ))
        }
        _ => return Err(state_err("skill reference.type must be \"rust\"")),
    }
    let has_use = obj.get("use").and_then(Value::as_str).is_some_and(|s| !s.is_empty());
    if !has_use {
        return Err(state_err(
            "skill reference requires \"use\" (e.g. \"agent_lib::skills::my_skill\")",
        ));
    }
    let has_call = ["callable", "call_pattern"]
        .iter()
        .any(|key| obj.get(*key).and_then(Value::as_str).is_some_and(|s| !s.is_empty()));
    if !has_call {
        return Err(state_err("skill reference requires a callable or call_pattern"));
    }
    Ok(())
}

fn slug(raw: &str, fallback: &str) -> String {
    let normalized: String = raw
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    let joined = normalized
        .split('_')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("_");
    let base = if joined.is_empty() { fallback.to_string() } else { joined };
    base.chars().take(80).collect()
}

/// ISO-8601 UTC timestamp without a chrono dependency (civil-from-days,
/// Howard Hinnant's algorithm).
fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

#[derive(Serialize, Deserialize, Default)]
struct StateFile {
    #[serde(default = "schema_version")]
    schema: u64,
    #[serde(default)]
    entries: BTreeMap<String, BTreeMap<String, Entry>>,
    #[serde(default)]
    refinements: Vec<RefinementEvent>,
}

fn schema_version() -> u64 {
    1
}

/// Handle on one harness store (local or global).
pub struct Harness {
    file: PathBuf,
    scope: &'static str,
    state: StateFile,
    loaded_mtime: Option<SystemTime>,
}

/// The session-local harness store (preopened at /agent/harness).
pub fn local() -> Result<Harness> {
    Harness::at_dir(resolve_dir("RLM_HARNESS_DIR", LOCAL_DIR), "local")
}

/// The cross-session global harness store (preopened at /agent/harness-global).
pub fn global() -> Result<Harness> {
    Harness::at_dir(resolve_dir("RLM_GLOBAL_HARNESS_DIR", GLOBAL_DIR), "global")
}

#[cfg(not(target_os = "wasi"))]
fn resolve_dir(env: &str, fixed: &str) -> PathBuf {
    // Native tests point the stores at temp dirs; in the sandbox the preopen
    // paths are fixed and the host never sets these variables.
    std::env::var(env).map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(fixed))
}

#[cfg(target_os = "wasi")]
fn resolve_dir(_env: &str, fixed: &str) -> PathBuf {
    PathBuf::from(fixed)
}

impl Harness {
    fn at_dir(dir: PathBuf, scope: &'static str) -> Result<Harness> {
        if !dir.exists() {
            return Err(state_err(format!(
                "{scope} harness state is unavailable in this session (no {} mount)",
                dir.display()
            )));
        }
        let mut harness = Harness {
            file: dir.join(FILE_NAME),
            scope,
            state: StateFile::default(),
            loaded_mtime: None,
        };
        harness.load();
        Ok(harness)
    }

    fn disk_mtime(&self) -> Option<SystemTime> {
        std::fs::metadata(&self.file).and_then(|meta| meta.modified()).ok()
    }

    fn load(&mut self) {
        self.loaded_mtime = self.disk_mtime();
        // A corrupt or missing state file degrades to empty (host parity); the
        // next save rewrites it cleanly.
        self.state = std::fs::read_to_string(&self.file)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        self.state.schema = 1;
    }

    /// Reload when another process (host `/refine`) rewrote the file since we
    /// last touched it, so an in-cell save never clobbers host edits.
    fn sync_from_disk(&mut self) {
        if self.disk_mtime() != self.loaded_mtime {
            self.load();
        }
    }

    fn save(&mut self) -> Result<()> {
        let body = serde_json::to_string_pretty(&self.state).map_err(|e| state_err(e.to_string()))?;
        // Cells run one at a time, so a time-derived suffix is unique enough;
        // std::process::id() traps on wasm32-wasip1 (unsupported syscall).
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let tmp = self.file.with_extension(format!("json.tmp{nanos}"));
        std::fs::write(&tmp, format!("{body}\n")).map_err(|e| state_err(format!("writing harness state: {e}")))?;
        std::fs::rename(&tmp, &self.file).map_err(|e| state_err(format!("saving harness state: {e}")))?;
        self.loaded_mtime = self.disk_mtime();
        Ok(())
    }

    fn strip_scope_prefix<'a>(&self, id: &'a str) -> Result<&'a str> {
        // overview() displays ids as [local:id]/[global:id]; accept those
        // verbatim when they match this store's scope.
        if let Some((prefix, rest)) = id.split_once(':') {
            if prefix == self.scope {
                return Ok(rest);
            }
            if prefix == "local" || prefix == "global" {
                return Err(state_err(format!(
                    "entry {id:?} belongs to the {prefix} store; use rlm::harness::{prefix}()"
                )));
            }
        }
        Ok(id)
    }

    fn kind_entries(&mut self, kind: &str) -> Result<&mut BTreeMap<String, Entry>> {
        if !KINDS.contains(&kind) {
            return Err(state_err(format!("unknown harness kind {kind:?}; expected one of {KINDS:?}")));
        }
        Ok(self.state.entries.entry(kind.to_string()).or_default())
    }

    fn upsert(&mut self, kind: &str, id: &str, title: &str, content: &str, fields: UpsertFields) -> Result<Entry> {
        let scope = self.scope.to_string();
        let entries = self.kind_entries(kind)?;
        let entry = match entries.get_mut(id) {
            Some(existing) => {
                existing.title = title.to_string();
                existing.content = content.to_string();
                // None preserves path/reference/arguments/metadata so a
                // title/content update cannot wipe a skill's contract; an
                // explicit value (including {}) still overwrites.
                if let Some(path) = fields.path {
                    existing.path = path;
                }
                if let Some(reference) = fields.reference {
                    existing.reference = reference;
                }
                if let Some(arguments) = fields.arguments {
                    existing.arguments = arguments;
                }
                if let Some(metadata) = fields.metadata {
                    existing.metadata = metadata;
                }
                existing.updated_at = now_iso();
                existing.version += 1;
                existing.clone()
            }
            None => {
                let now = now_iso();
                let entry = Entry {
                    id: id.to_string(),
                    kind: kind.to_string(),
                    title: title.to_string(),
                    content: content.to_string(),
                    path: fields.path.unwrap_or_else(default_path),
                    scope,
                    reference: fields.reference.unwrap_or_else(empty_object),
                    arguments: fields.arguments.unwrap_or_else(empty_object),
                    metadata: fields.metadata.unwrap_or_else(empty_object),
                    source: "agent".to_string(),
                    created_at: now.clone(),
                    updated_at: now,
                    version: 1,
                };
                entries.insert(id.to_string(), entry.clone());
                entry
            }
        };
        self.save()?;
        Ok(entry)
    }

    fn create(&mut self, kind: &str, title: &str, content: &str, fields: UpsertFields) -> Result<Entry> {
        self.sync_from_disk();
        let id = fields.id.clone().unwrap_or_else(|| slug(title, kind));
        let id = self.strip_scope_prefix(&id)?.to_string();
        if self.kind_entries(kind)?.contains_key(&id) {
            return Err(state_err(format!("{kind} entry {id:?} already exists")));
        }
        self.upsert(kind, &id, title, content, fields)
    }

    fn update_entry(&mut self, kind: &str, id: &str, title: &str, content: &str, fields: UpsertFields) -> Result<Entry> {
        self.sync_from_disk();
        let id = self.strip_scope_prefix(id)?.to_string();
        if !self.kind_entries(kind)?.contains_key(&id) {
            return Err(state_err(format!("{kind} entry {id:?} does not exist")));
        }
        self.upsert(kind, &id, title, content, fields)
    }

    /// Fetch one entry.
    pub fn get(&mut self, kind: &str, id: &str) -> Result<Option<Entry>> {
        self.sync_from_disk();
        let id = self.strip_scope_prefix(id)?.to_string();
        Ok(self.kind_entries(kind)?.get(&id).cloned())
    }

    /// List entries, optionally filtered by kind.
    pub fn list(&mut self, kind: Option<&str>) -> Result<Vec<Entry>> {
        self.sync_from_disk();
        let kinds: Vec<&str> = match kind {
            Some(kind) if KINDS.contains(&kind) => vec![kind],
            Some(kind) => return Err(state_err(format!("unknown harness kind {kind:?}"))),
            None => KINDS.to_vec(),
        };
        let mut all = Vec::new();
        for kind in kinds {
            if let Some(entries) = self.state.entries.get(kind) {
                all.extend(entries.values().cloned());
            }
        }
        Ok(all)
    }

    /// Delete one entry. Returns whether it existed.
    pub fn delete(&mut self, kind: &str, id: &str) -> Result<bool> {
        self.sync_from_disk();
        let id = self.strip_scope_prefix(id)?.to_string();
        let removed = self.kind_entries(kind)?.remove(&id).is_some();
        if removed {
            self.save()?;
        }
        Ok(removed)
    }

    /// Create a memory entry (durable facts, decisions, preferences).
    pub fn create_memory(&mut self, title: &str, content: &str) -> Result<Entry> {
        self.create("memory", title, content, UpsertFields::default())
    }

    /// Create a prompt-note entry (narrow behavioral policy addendums).
    pub fn create_prompt_note(&mut self, title: &str, content: &str) -> Result<Entry> {
        self.create("prompt", title, content, UpsertFields::default())
    }

    /// Create a skill entry. `reference` must be a rust reference
    /// (`{"type":"rust","use":"agent_lib::skills::x","call_pattern":"…"}`);
    /// `arguments` documents accepted inputs.
    pub fn create_skill(&mut self, title: &str, content: &str, reference: Value, arguments: Value) -> Result<Entry> {
        validate_rust_skill_reference(&reference)?;
        self.create(
            "skill",
            title,
            content,
            UpsertFields {
                reference: Some(reference),
                arguments: Some(arguments),
                ..UpsertFields::default()
            },
        )
    }

    /// Create a subagent spec entry (reusable delegation roles).
    pub fn create_subagent(&mut self, title: &str, content: &str) -> Result<Entry> {
        self.create("subagent", title, content, UpsertFields::default())
    }

    /// Update an existing entry's title and content (other fields preserved).
    pub fn update(&mut self, kind: &str, id: &str, title: &str, content: &str) -> Result<Entry> {
        if kind == "skill" {
            // A skill's contract updates through update_skill so the reference
            // stays validated; plain updates keep the stored reference.
        }
        self.update_entry(kind, id, title, content, UpsertFields::default())
    }

    /// Update a skill entry including its (validated) reference/arguments.
    pub fn update_skill(
        &mut self,
        id: &str,
        title: &str,
        content: &str,
        reference: Value,
        arguments: Value,
    ) -> Result<Entry> {
        validate_rust_skill_reference(&reference)?;
        self.update_entry(
            "skill",
            id,
            title,
            content,
            UpsertFields {
                reference: Some(reference),
                arguments: Some(arguments),
                ..UpsertFields::default()
            },
        )
    }

    /// Record a refinement pass (what changed and why).
    pub fn record_refinement(&mut self, trigger: &str, changes: &[&str], evidence: &str, outcome: &str) -> Result<RefinementEvent> {
        self.sync_from_disk();
        let event = RefinementEvent {
            id: format!("refine_{:04}", self.state.refinements.len() + 1),
            trigger: trigger.to_string(),
            changes: changes.iter().map(|change| change.to_string()).collect(),
            evidence: evidence.to_string(),
            outcome: outcome.to_string(),
            created_at: now_iso(),
        };
        self.state.refinements.push(event.clone());
        self.save()?;
        Ok(event)
    }

    /// Compact human-readable listing of every entry, newest refinements last.
    pub fn overview(&mut self) -> Result<String> {
        self.sync_from_disk();
        let mut lines = Vec::new();
        for kind in KINDS {
            let entries = self.state.entries.get(kind);
            let count = entries.map(|map| map.len()).unwrap_or(0);
            lines.push(format!("{kind} ({count}):"));
            if let Some(entries) = entries {
                for entry in entries.values() {
                    let mut content = entry.content.replace('\n', " ");
                    if content.chars().count() > 120 {
                        content = content.chars().take(120).collect::<String>() + "…";
                    }
                    lines.push(format!(
                        "- [{}:{}] {} ({}, v{}): {content}",
                        entry.scope, entry.id, entry.title, entry.path, entry.version
                    ));
                }
            }
        }
        lines.push(format!("refinements: {}", self.state.refinements.len()));
        Ok(lines.join("\n"))
    }
}

#[derive(Default)]
struct UpsertFields {
    id: Option<String>,
    path: Option<String>,
    reference: Option<Value>,
    arguments: Option<Value>,
    metadata: Option<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::atomic::{AtomicU32, Ordering};

    static NEXT: AtomicU32 = AtomicU32::new(0);

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> TempDir {
            let dir = std::env::temp_dir().join(format!(
                "rlm-harness-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp_store() -> (TempDir, Harness) {
        let dir = TempDir::new();
        let harness = Harness::at_dir(dir.path().to_path_buf(), "local").unwrap();
        (dir, harness)
    }

    #[test]
    fn crud_round_trip_and_versioning() {
        let (dir, mut harness) = temp_store();
        let entry = harness.create_memory("Build Uses Ninja", "The project builds with ninja.").unwrap();
        assert_eq!(entry.id, "build_uses_ninja");
        assert_eq!(entry.version, 1);

        let updated = harness.update("memory", "build_uses_ninja", "Build Uses Ninja", "ninja -C out").unwrap();
        assert_eq!(updated.version, 2);
        assert_eq!(updated.created_at, entry.created_at);

        let mut reopened = Harness::at_dir(dir.path().to_path_buf(), "local").unwrap();
        let fetched = reopened.get("memory", "local:build_uses_ninja").unwrap().unwrap();
        assert_eq!(fetched.content, "ninja -C out");
        assert!(reopened.delete("memory", "build_uses_ninja").unwrap());
        assert!(!reopened.delete("memory", "build_uses_ninja").unwrap());
    }

    #[test]
    fn skill_reference_validation_is_rust_only() {
        let (_dir, mut harness) = temp_store();
        let err = harness
            .create_skill("Fetcher", "use it", json!({"type": "python", "import": "fetcher"}), json!({}))
            .unwrap_err();
        assert!(format!("{err:#}").contains("legacy"));

        let err = harness
            .create_skill("Fetcher", "use it", json!({"type": "rust", "use": "agent_lib::skills::fetcher"}), json!({}))
            .unwrap_err();
        assert!(format!("{err:#}").contains("callable or call_pattern"));

        let entry = harness
            .create_skill(
                "Fetcher",
                "use it",
                json!({"type": "rust", "use": "agent_lib::skills::fetcher", "call_pattern": "agent_lib::skills::fetcher::run(url)?"}),
                json!({"url": "required"}),
            )
            .unwrap();
        assert_eq!(entry.reference["type"], "rust");
    }

    #[test]
    fn out_of_process_writes_are_not_clobbered() {
        let (dir, mut harness) = temp_store();
        harness.create_memory("First", "one").unwrap();

        // Simulate the host /refine rewriting the file out-of-process.
        let file = dir.path().join(FILE_NAME);
        let mut raw: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        raw["entries"]["memory"]["host_added"] = json!({
            "id": "host_added", "kind": "memory", "title": "Host", "content": "from host",
            "path": "general", "scope": "local", "reference": {}, "arguments": {}, "metadata": {},
            "source": "refine", "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
            "version": 1
        });
        // Ensure the mtime moves even on coarse filesystem clocks.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&file, serde_json::to_string_pretty(&raw).unwrap()).unwrap();

        // The next in-cell mutation must re-sync first and keep the host entry.
        harness.create_memory("Second", "two").unwrap();
        let ids: Vec<String> = harness.list(Some("memory")).unwrap().into_iter().map(|e| e.id).collect();
        assert!(ids.contains(&"host_added".to_string()), "host edit clobbered: {ids:?}");
        assert!(ids.contains(&"first".to_string()));
        assert!(ids.contains(&"second".to_string()));
    }

    #[test]
    fn unavailable_store_is_a_state_error() {
        let err = match Harness::at_dir(PathBuf::from("/definitely-missing-dir"), "local") {
            Err(err) => err,
            Ok(_) => panic!("expected a missing-mount error"),
        };
        assert!(format!("{err:#}").contains("unavailable"));
    }
}

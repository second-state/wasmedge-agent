//! Typed error for rlm operations (DESIGN.md §2.6). Public APIs return
//! `anyhow::Result`; this type rides inside so callers who care can downcast
//! and match on the kind while `?` and `{:#}` stay ergonomic for cells.

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// Transport-level failure talking to the host bridge (connect, framing,
    /// timeout, connection lost).
    Bridge,
    /// The host handled the request and reported an error.
    Host,
    /// Persistent-state layer failure (`rlm::state`).
    State,
    /// Local I/O failure.
    Io,
}

#[derive(Debug, Clone)]
pub struct Error {
    pub kind: ErrorKind,
    pub message: String,
}

impl Error {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn bridge(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Bridge, message)
    }

    pub fn host(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Host, message)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.kind {
            ErrorKind::Bridge => write!(f, "bridge error: {}", self.message),
            ErrorKind::Host => write!(f, "{}", self.message),
            ErrorKind::State => write!(f, "state error: {}", self.message),
            ErrorKind::Io => write!(f, "io error: {}", self.message),
        }
    }
}

impl std::error::Error for Error {}

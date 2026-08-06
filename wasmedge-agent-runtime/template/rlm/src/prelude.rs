//! Common imports for code that talks to the rlm runtime directly
//! (DESIGN.md §2.6). Cells usually get these via `agent_lib::prelude::*`.

pub use anyhow::{anyhow, bail, Context, Error as AnyError, Result};

pub use crate::error::{Error, ErrorKind};
pub use crate::{
    compact, delete_subagent, deps, display, find_models, goal, heartbeat, host_request, list_subagents, mcp, msg,
    observe, refine, spawn, spawn_named, spawn_with, state, Model, SpawnHandle, SpawnOpts, Subagent,
};

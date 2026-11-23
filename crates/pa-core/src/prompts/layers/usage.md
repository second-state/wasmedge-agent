A cell that saves a count for the next turn can use this program.

```rust
use agent_lib::prelude::*;

fn main() -> Result<()> {
    let n = std::fs::read_dir("/workspace")?.count();
    rlm::state::set("project_entries", &n)?;
    println!("{n} entries");
    Ok(())
}
```

Read stored values after a resume or compaction. Use the compiler diagnostics to repair a cell. For rich output use `rlm::display::diff` or `rlm::display::attach_image`. In a read-only workspace, return a patch for application by an authorized host tool.

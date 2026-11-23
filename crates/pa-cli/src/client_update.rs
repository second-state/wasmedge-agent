//! The interactive updater runs the public CLI command and captures its output.
#[derive(Clone, Default)]
pub struct ClientUpdate;

impl pa_tui::update_command::UpdateCommands for ClientUpdate {
    fn run_update(&self) -> pa_tui::update_command::UpdateRunFuture {
        Box::pin(async {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let output = tokio::process::Command::new(exe)
                .arg("update")
                .env(
                    crate::public_command::SELF_UPDATE_INTERACTIVE_CHILD_ENV,
                    "1",
                )
                .stdin(std::process::Stdio::null())
                .output()
                .await
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(format!(
                    "{}{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
            crate::config::packaged_manifest_version()
                .ok_or_else(|| "updated package has no version".to_string())
        })
    }
}

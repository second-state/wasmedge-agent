//! Update configured Git resources and report available revisions.

use anyhow::{bail, Result};

use super::manager::{PackageManager, PackageUpdate, ProgressAction};
use super::source::{parse_source, ParsedSource, SourceScope, UserOrProject};

impl PackageManager {
    /// Update configured packages. With a source, only packages with the same
    /// identity update; an unknown source is an error with a suggestion.
    ///
    /// # Errors
    ///
    /// Error when the source matches no configured package, or the update/reinstall fails.
    pub fn update(&mut self, source: Option<&str>) -> Result<()> {
        if source.is_some_and(|s| parse_source(s) == ParsedSource::LegacyRegistry) {
            bail!("{}", super::LEGACY_SOURCE_MESSAGE);
        }
        let identity = source.map(|source| self.get_source_match_key_for_input(source));
        let mut matched = false;
        let mut update_sources: Vec<(String, UserOrProject)> = Vec::new();

        for scope in [UserOrProject::User, UserOrProject::Project] {
            for entry in self.packages_for_scope(scope).unwrap_or_default() {
                let (source_str, _) = super::manager::split_entry(&entry);
                if let Some(identity) = &identity {
                    if &self.get_source_match_key_for_settings(&source_str, scope) != identity {
                        continue;
                    }
                }
                matched = true;
                update_sources.push((source_str, scope));
            }
        }

        if let Some(source) = source {
            if !matched {
                let configured = [
                    self.packages_for_scope(UserOrProject::User)
                        .unwrap_or_default(),
                    self.packages_for_scope(UserOrProject::Project)
                        .unwrap_or_default(),
                ]
                .concat();
                bail!(Self::build_no_matching_package_message(source, &configured));
            }
        }

        self.update_configured_sources(update_sources)
    }

    /// Packages (across both scopes) with an available update; project
    /// entries win over user entries for the same package.
    pub fn check_for_available_updates(&mut self) -> Vec<PackageUpdate> {
        if super::is_offline_mode_enabled() {
            return Vec::new();
        }
        let mut seen = std::collections::HashSet::new();
        let mut updates = Vec::new();
        // Project first so its entries win the identity dedupe.
        for scope in [UserOrProject::Project, UserOrProject::User] {
            for entry in self.packages_for_scope(scope).unwrap_or_default() {
                let (source, _) = super::manager::split_entry(&entry);
                if !seen.insert(self.get_source_match_key_for_settings(&source, scope)) {
                    continue;
                }
                if let ParsedSource::Git(parsed) = parse_source(&source) {
                    if !parsed.pinned
                        && self
                            .get_installed_path(&source, scope)
                            .is_some_and(|path| super::git::git_has_available_update(&path))
                    {
                        updates.push(PackageUpdate {
                            source,
                            display_name: format!("{}/{}", parsed.host, parsed.path),
                            kind: "git",
                            scope,
                        });
                    }
                }
            }
        }
        updates
    }

    fn update_configured_sources(&mut self, sources: Vec<(String, UserOrProject)>) -> Result<()> {
        if super::is_offline_mode_enabled() || sources.is_empty() {
            return Ok(());
        }

        for (source, scope) in sources {
            let ParsedSource::Git(parsed) = parse_source(&source) else {
                continue;
            };
            if !parsed.pinned {
                self.with_progress(
                    ProgressAction::Update,
                    &source,
                    &format!("Updating {source}..."),
                    |manager| {
                        super::git::update_git(
                            &parsed,
                            SourceScope::from(scope),
                            manager.cwd(),
                            manager.agent_dir(),
                        )
                    },
                )?;
            }
        }
        Ok(())
    }

    /// `No matching package found for <source>` with the configured source the
    /// input most plausibly meant, if any.
    fn build_no_matching_package_message(source: &str, configured: &[serde_json::Value]) -> String {
        let trimmed = source.trim();
        for entry in configured {
            let (candidate, _) = super::manager::split_entry(entry);
            if let ParsedSource::Git(parsed) = parse_source(&candidate) {
                let shorthand = format!("{}/{}", parsed.host, parsed.path);
                let with_ref = parsed.r#ref.as_ref().map(|r| format!("{shorthand}@{r}"));
                if trimmed == shorthand || with_ref.is_some_and(|r| trimmed == r) {
                    return format!(
                        "No matching package found for {source}. Did you mean {candidate}?"
                    );
                }
            }
        }
        format!("No matching package found for {source}")
    }
}

use anyhow::{ensure, Context, Result};
use serde_json::Value;
use std::{collections::HashSet, fs, io::Write, path::Path};

fn validate(models: &[u8], services: &[u8]) -> Result<()> {
    let catalog: Value = serde_json::from_slice(models)?;
    ensure!(catalog["schemaVersion"] == 1, "unsupported model catalog");
    let mut ids = HashSet::new();
    let mut transports = HashSet::new();
    for model in catalog["models"].as_array().context("missing model list")? {
        for key in ["id", "name", "provider", "api"] {
            ensure!(
                model[key].as_str().is_some_and(|s| !s.is_empty()),
                "invalid model {key}"
            );
        }
        ensure!(
            model["reasoning"].is_boolean()
                && model["input"].as_array().is_some_and(|v| !v.is_empty()
                    && v.iter()
                        .all(|x| matches!(x.as_str(), Some("text" | "image")))),
            "invalid model capabilities"
        );
        for key in ["input", "output", "cacheRead", "cacheWrite"] {
            ensure!(model["cost"][key].as_f64().is_some(), "invalid model cost");
        }
        for key in ["contextWindow", "maxTokens"] {
            ensure!(
                model[key].as_u64().is_some_and(|n| n > 0),
                "invalid model token limit"
            );
        }
        let provider = model["provider"].as_str().unwrap();
        let endpoint = model["baseUrl"].as_str().context("missing model URL")?;
        transports.insert((provider, model["api"].as_str().unwrap(), endpoint));
        ensure!(
            ids.insert((provider, model["id"].as_str().unwrap())),
            "duplicate model"
        );
    }
    ensure!(transports.len() >= 42, "incomplete model catalog");
    let catalog: Value = serde_json::from_slice(services)?;
    ensure!(catalog["version"] == 2, "unsupported MCP catalog");
    let mut names = HashSet::new();
    for entry in catalog["entries"]
        .as_array()
        .context("missing MCP services")?
    {
        for key in ["server", "service", "label"] {
            ensure!(
                entry[key].as_str().is_some_and(|s| !s.is_empty()),
                "invalid MCP service {key}"
            );
        }
        for (key, field) in [
            ("transport", "type"),
            ("auth", "strategy"),
            ("setup", "status"),
            ("verification", "status"),
        ] {
            ensure!(entry[key][field].is_string(), "invalid MCP service {key}");
        }
        let url = entry["url"].as_str().context("missing service URL")?;
        ensure!(
            !url.is_empty()
                || matches!(
                    entry["transport"]["type"].as_str(),
                    Some("stdio" | "http-template")
                ),
            "missing service endpoint"
        );
        ensure!(
            entry["provenance"]
                .as_array()
                .is_some_and(|p| !p.is_empty())
                && entry["aliases"]
                    .as_array()
                    .is_some_and(|p| p.iter().all(Value::is_string))
                && entry["legacyBuiltin"].is_boolean(),
            "invalid MCP descriptor"
        );
        ensure!(
            names.insert(entry["server"].as_str().unwrap()),
            "duplicate MCP server"
        );
    }
    ensure!(names.len() >= 20, "incomplete MCP catalog");
    Ok(())
}
pub(super) fn refresh(root: &Path, args: &[String]) -> Result<()> {
    let out = root.join("catalog");
    let names = ["models.bundled.json", "mcp-services.bundled.json"];
    let paths = match args {
        [] => names.map(|n| out.join(n)),
        [dir] => {
            ["models/catalog.v1.json", "plugins/catalog.v2.json"].map(|n| Path::new(dir).join(n))
        }
        _ => anyhow::bail!("usage: xtask catalog [CATALOG_CHECKOUT]"),
    };
    let models = fs::read(&paths[0])?;
    let services = fs::read(&paths[1])?;
    validate(&models, &services)?;
    if !args.is_empty() {
        for (name, bytes) in names.into_iter().zip([models, services]) {
            let mut file = tempfile::NamedTempFile::new_in(&out)?;
            file.write_all(&bytes)?;
            file.persist(out.join(name))?;
        }
    }
    Ok(())
}

//! Resolve public Rust paths across the local rustdoc JSON documents.
use anyhow::{ensure, Context, Result};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

type Docs = BTreeMap<String, Value>;
type Key = (String, u64);
struct Index<'a> {
    docs: &'a Docs,
    definitions: HashMap<String, Key>,
    visiting: HashSet<Key>,
    entries: BTreeMap<(String, Key), Value>,
}
fn kind(item: &Value) -> Result<(&str, &Value)> {
    let inner = item["inner"]
        .as_object()
        .context("invalid rustdoc declaration")?;
    ensure!(inner.len() == 1, "ambiguous rustdoc declaration");
    let (kind, body) = inner.iter().next().unwrap();
    Ok((kind, body))
}
fn namespace(kind: &str) -> &str {
    match kind {
        "function" | "constant" | "static" | "variant" => "value",
        k if k.contains("macro") => "macro",
        _ => "type",
    }
}
fn canonical(path: &Value) -> Option<String> {
    Some(
        path.as_array()?
            .iter()
            .map(Value::as_str)
            .collect::<Option<Vec<_>>>()?
            .join("::"),
    )
}

impl Index<'_> {
    fn resolve(&self, doc: &str, id: &Value) -> Option<Key> {
        let id = id.as_u64()?;
        let data = self.docs.get(doc)?;
        if data["index"].get(id.to_string()).is_some() {
            return Some((doc.to_owned(), id));
        }
        self.definitions
            .get(&canonical(&data["paths"][id.to_string()]["path"])?)
            .cloned()
    }
    fn item(&self, key: &Key) -> &Value {
        &self.docs[&key.0]["index"][key.1.to_string()]
    }
    fn visit(&mut self, key: Key, path: &str, context: &Value) -> Result<()> {
        let map_key = (path.to_owned(), key.clone());
        if self.entries.contains_key(&map_key) || !self.visiting.insert(key.clone()) {
            return Ok(());
        }
        ensure!(
            self.entries.len() < 20_000,
            "rustdoc API exceeds 20000 items"
        );
        let item = self.item(&key).clone();
        let (kind, body) = kind(&item)?;
        if kind == "use" {
            let glob = body["is_glob"] == true;
            if let Some(other) = self.resolve(&key.0, &body["id"]) {
                if glob {
                    let item = self.item(&other);
                    let ids = item
                        .pointer("/inner/module/items")
                        .or_else(|| item.pointer("/inner/enum/variants"))
                        .cloned();
                    let public = item.pointer("/inner/module").is_some();
                    if let Some(ids) = ids {
                        self.members(&other.0, &ids, path, public, &Value::Null, true)?;
                    }
                } else {
                    self.visit(other, path, context)?;
                }
            } else {
                let path = if glob {
                    format!("{path}::*#{}", key.1)
                } else {
                    path.to_owned()
                };
                self.entries.insert(map_key,json!({"path":path,"kind":"external_reexport","docs":item["docs"],"declaration":item["inner"]}));
            }
        } else {
            let mut entry = json!({"path":path,"kind":kind,"docs":item["docs"]});
            if !context.is_null() {
                entry["context"] = context.clone();
            }
            self.entries.insert(map_key.clone(), entry);
            let generics = if kind == "trait" {
                &body["generics"]
            } else {
                &Value::Null
            };
            let decl = self.expand(&key.0, body, path, kind == "module", generics)?;
            self.entries.get_mut(&map_key).unwrap()["declaration"] = json!({(kind):decl});
        }
        self.visiting.remove(&key);
        Ok(())
    }
    fn members(
        &mut self,
        doc: &str,
        ids: &Value,
        parent: &str,
        public: bool,
        context: &Value,
        glob: bool,
    ) -> Result<Vec<Value>> {
        let mut ids = ids
            .as_array()
            .context("invalid rustdoc references")?
            .clone();
        ids.sort_by_key(|id| {
            self.resolve(doc, id).is_some_and(|key| {
                self.item(&key).pointer("/inner/use/is_glob") == Some(&Value::Bool(true))
            })
        });
        let mut result = Vec::new();
        for id in ids {
            let Some(key) = self.resolve(doc, &id) else {
                result.push(if id.is_null() {
                    json!({"stripped":true})
                } else {
                    json!({"unavailable":true})
                });
                continue;
            };
            let item = self.item(&key).clone();
            if public && item["visibility"] != "public" {
                continue;
            }
            let (kind, body) = kind(&item)?;
            if kind == "impl" {
                if body["is_synthetic"] == true || !body["blanket_impl"].is_null() {
                    continue;
                }
                if body["trait"].is_null() {
                    result.extend(self.members(
                        &key.0,
                        &body["items"],
                        parent,
                        true,
                        &json!({"generics":body["generics"],"for":body["for"]}),
                        false,
                    )?);
                    continue;
                }
            }
            let is_glob = kind == "use" && body["is_glob"] == true;
            let name = if kind == "use" {
                &body["name"]
            } else {
                &item["name"]
            };
            let ident = name.as_str().map_or_else(
                || format!("impl#{}", key.1),
                |n| {
                    if super::dependencies::RESERVED
                        .split_whitespace()
                        .any(|w| w == n)
                        && ![
                            "std",
                            "core",
                            "alloc",
                            "rlm",
                            "agent_lib",
                            "cell",
                            "anyhow",
                            "regex",
                            "serde",
                            "serde_json",
                            "walkdir",
                            "proc_macro",
                        ]
                        .contains(&n)
                    {
                        format!("r#{n}")
                    } else {
                        n.to_owned()
                    }
                },
            );
            let path = if is_glob {
                parent.to_owned()
            } else {
                format!("{parent}::{ident}")
            };
            if glob
                && self
                    .entries
                    .range((path.clone(), (String::new(), 0))..)
                    .take_while(|((p, _), _)| p == &path)
                    .any(|(_, v)| namespace(v["kind"].as_str().unwrap_or("")) == namespace(kind))
            {
                continue;
            }
            let before = if is_glob {
                self.entries.keys().cloned().collect::<BTreeSet<_>>()
            } else {
                BTreeSet::new()
            };
            self.visit(key, &path, context)?;
            if is_glob {
                let prefix = format!("{parent}::");
                result.extend(
                    self.entries
                        .iter()
                        .filter(|(key, _)| {
                            !before.contains(*key)
                                && key
                                    .0
                                    .strip_prefix(&prefix)
                                    .is_some_and(|n| !n.contains("::"))
                        })
                        .map(|(_, v)| json!({"path":v["path"],"kind":v["kind"]})),
                );
            } else {
                result.push(json!({"path":path,"kind":kind}));
            }
        }
        Ok(result)
    }
    fn expand(
        &mut self,
        doc: &str,
        value: &Value,
        parent: &str,
        public: bool,
        generics: &Value,
    ) -> Result<Value> {
        if let Some(a) = value.as_array() {
            return Ok(Value::Array(
                a.iter()
                    .map(|v| self.expand(doc, v, parent, public, &Value::Null))
                    .collect::<Result<_>>()?,
            ));
        }
        let Some(map) = value.as_object() else {
            return Ok(value.clone());
        };
        let mut out = Map::new();
        for (k, v) in map {
            let refs = matches!(
                k.as_str(),
                "fields" | "variants" | "items" | "impls" | "implementations"
            ) || k == "tuple"
                && v.as_array()
                    .is_some_and(|a| a.iter().all(|x| x.is_null() || x.is_u64()));
            let entry = if refs && v.is_array() {
                let context = if generics.is_null() {
                    Value::Null
                } else {
                    json!({"generics":generics})
                };
                Value::Array(self.members(
                    doc,
                    v,
                    parent,
                    k == "items" && public,
                    &context,
                    false,
                )?)
            } else {
                self.expand(doc, v, parent, public, generics)?
            };
            out.insert(k.clone(), entry);
        }
        Ok(Value::Object(out))
    }
}

pub(super) fn build(docs: &Docs) -> Result<Value> {
    let mut index = Index {
        docs,
        definitions: HashMap::new(),
        visiting: HashSet::new(),
        entries: BTreeMap::new(),
    };
    for (name, doc) in docs {
        ensure!(
            doc["format_version"] == 61,
            "unsupported rustdoc JSON format"
        );
        let root = doc["root"].as_u64().context("missing rustdoc root")?;
        index.definitions.insert(name.clone(), (name.clone(), root));
        for (id, desc) in doc["paths"].as_object().context("missing rustdoc paths")? {
            if let Some(path) = canonical(&desc["path"]) {
                if path.starts_with(&format!("{name}::")) && doc["index"].get(id).is_some() {
                    index.definitions.insert(path, (name.clone(), id.parse()?));
                }
            }
        }
    }
    for name in ["agent_lib", "rlm"] {
        let root = docs.get(name).context("missing guest crate rustdoc")?["root"]
            .as_u64()
            .context("invalid root")?;
        index.visit((name.into(), root), name, &Value::Null)?;
    }
    Ok(Value::Array(index.entries.into_values().collect()))
}

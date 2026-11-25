use std::fs::{self, File};
use std::io::{ErrorKind, Read};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use serde::Deserialize;

use crate::config::{
    CheckConfig, CheckDirConfig, CheckDirDefaults, CheckKind, RawCheckConfig, non_empty,
};
use crate::protocol::CheckSnapshot;

const SCRIPT_HEADER_CAP_BYTES: usize = 2048;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MultiDropIn {
    checks: Vec<RawCheckConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum DropInFile {
    Multi(MultiDropIn),
    Single(Box<RawCheckConfig>),
}

fn sanitize_slug(stem: &str) -> String {
    let mut slug: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-') {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    if !slug.starts_with(|c: char| c.is_ascii_alphanumeric()) {
        slug.insert(0, 'x');
        slug.truncate(64);
    }

    slug
}

fn unquote(raw: &str) -> &str {
    let s = raw.trim();
    let quoted = s.len() >= 2
        && ((s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\'')));

    if quoted { &s[1..s.len() - 1] } else { s }
}

fn build_check(
    mut item: RawCheckConfig,
    fallback_stem: Option<&str>,
    base_dir: &Path,
    defaults: CheckDirDefaults<'_>,
) -> Result<CheckConfig, String> {
    if item.kind == CheckKind::Exec
        && let Some(first) = item.command.first_mut()
        && (first.starts_with("./") || first.starts_with("../"))
    {
        *first = base_dir.join(&*first).to_string_lossy().into_owned();
    }

    let raw_key = item.key.as_deref().and_then(non_empty);
    let Some(key_src) = raw_key.or(fallback_stem) else {
        return Err("missing key".to_string());
    };
    let key = sanitize_slug(key_src);
    let label = item
        .label
        .as_deref()
        .and_then(non_empty)
        .unwrap_or(key_src)
        .to_string();
    let group = item
        .group
        .as_deref()
        .and_then(non_empty)
        .or(defaults.group)
        .map(str::to_string);

    item.into_check(key, label, group, defaults)
}

fn load_toml_dropin(
    path: &Path,
    stem: &str,
    base_dir: &Path,
    defaults: CheckDirDefaults<'_>,
) -> Result<Vec<CheckConfig>, String> {
    let raw = fs::read_to_string(path).map_err(|err| format!("failed to read drop-in: {err}"))?;
    let parsed: DropInFile =
        toml::from_str(&raw).map_err(|err| format!("invalid drop-in TOML: {err}"))?;

    match parsed {
        DropInFile::Multi(MultiDropIn { checks }) => {
            if checks.is_empty() {
                return Err("drop-in [[checks]] list is empty".to_string());
            }

            checks
                .into_iter()
                .enumerate()
                .map(|(idx, item)| {
                    build_check(item, None, base_dir, defaults)
                        .map_err(|msg| format!("checks[{idx}]: {msg}"))
                })
                .collect()
        }
        DropInFile::Single(item) => {
            let check = build_check(*item, Some(stem), base_dir, defaults)?;

            Ok(vec![check])
        }
    }
}

fn parse_script_metadata(path: &Path) -> RawCheckConfig {
    let mut meta = RawCheckConfig::default();
    let Ok(file) = File::open(path) else {
        return meta;
    };
    let mut buf = Vec::new();
    if file
        .take(SCRIPT_HEADER_CAP_BYTES as u64)
        .read_to_end(&mut buf)
        .is_err()
        || buf.contains(&0)
    {
        return meta;
    }

    for (idx, line) in String::from_utf8_lossy(&buf).lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || (idx == 0 && trimmed.starts_with("#!")) {
            continue;
        }
        let Some(comment) = trimmed.strip_prefix('#') else {
            break;
        };
        let Some((field, raw_val)) = comment
            .trim_start()
            .strip_prefix("uptarn.")
            .and_then(|rest| rest.split_once('='))
        else {
            continue;
        };
        let Some(val) = non_empty(unquote(raw_val)) else {
            continue;
        };
        match field.trim() {
            "key" => meta.key = Some(val.to_string()),
            "label" => meta.label = Some(val.to_string()),
            "group" => meta.group = Some(val.to_string()),
            "warn_exit_code" => meta.warn_exit_code = val.parse().ok().or(meta.warn_exit_code),
            "timeout_ms" => meta.timeout_ms = val.parse().ok().or(meta.timeout_ms),
            "format" => meta.format = val.parse().ok().or(meta.format),
            _ => {}
        }
    }

    meta
}

pub fn discover(dirs: &[CheckDirConfig]) -> (Vec<CheckConfig>, Vec<CheckSnapshot>) {
    let mut discovered = Vec::new();
    let mut errors = Vec::new();

    for entry in dirs {
        let (dir_path, defaults) = entry.parts();
        let base_dir = Path::new(dir_path);
        let read_dir = match fs::read_dir(base_dir) {
            Ok(rd) => rd,
            Err(err) if err.kind() == ErrorKind::NotFound => continue,
            Err(err) => {
                errors.push(CheckSnapshot::failed(
                    sanitize_slug(&format!("check_dir_{dir_path}")),
                    format!("check_dir {dir_path}"),
                    defaults.group.map(str::to_string),
                    format!("failed to read directory: {err}"),
                    None,
                ));
                continue;
            }
        };

        let mut paths: Vec<_> = read_dir
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| !n.starts_with('.'))
            })
            .collect();
        paths.sort();

        for path in paths {
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("collector");

            if path.extension().and_then(|e| e.to_str()) == Some("toml") {
                match load_toml_dropin(&path, stem, base_dir, defaults) {
                    Ok(items) => discovered.extend(items),
                    Err(err) => errors.push(CheckSnapshot::failed(
                        sanitize_slug(stem),
                        stem,
                        defaults.group.map(str::to_string),
                        err,
                        None,
                    )),
                }
            } else if (meta.permissions().mode() & 0o111) != 0 {
                let mut script = parse_script_metadata(&path);
                script.command = vec![path.to_string_lossy().into_owned()];
                if let Ok(check) = build_check(script, Some(stem), base_dir, defaults) {
                    discovered.push(check);
                }
            }
        }
    }

    (discovered, errors)
}

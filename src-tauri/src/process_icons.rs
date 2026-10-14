/// Choose the owning app, rather than a nested browser/helper app bundle.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn mac_app_bundle(path: &str) -> Option<String> {
    if !path.starts_with('/') || path.split('/').any(|part| part == "..") {
        return None;
    }
    let mut prefix = String::new();
    for part in path
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
    {
        prefix.push('/');
        prefix.push_str(part);
        if part.to_ascii_lowercase().ends_with(".app") {
            return Some(prefix);
        }
    }
    None
}

pub(crate) fn is_self_process(path: &str, name: Option<&str>) -> bool {
    [Some(path.rsplit(['/', '\\']).next().unwrap_or(path)), name]
        .into_iter()
        .flatten()
        .any(|name| {
            matches!(
                name.to_ascii_lowercase().as_str(),
                "flyclash" | "flyclash.exe" | "mihomo"
            )
        })
}

#[cfg(any(target_os = "macos", test))]
const ICON_SCRIPT: &str = r#"
ObjC.import('AppKit');
ObjC.import('Foundation');
function text(value) { try { return ObjC.unwrap(value) || ''; } catch (_) { return ''; } }
function run() {
  var environment = $.NSProcessInfo.processInfo.environment;
  var executable = text(environment.objectForKey('FLYCLASH_ICON_PATH'));
  var name = text(environment.objectForKey('FLYCLASH_ICON_NAME'));
  var hint = name.toLowerCase();
  var workspace = $.NSWorkspace.sharedWorkspace;
  var files = $.NSFileManager.defaultManager;
  var target = '';
  var bundle = executable.match(/^(.+?\.app)(?:\/|$)/i);
  if (bundle && files.fileExistsAtPath($(bundle[1]))) target = bundle[1];
  if (!target) {
    var applications = workspace.runningApplications;
    for (var i = 0; i < applications.count; i++) {
      try {
        var application = applications.objectAtIndex(i);
        var appExecutable = text(application.executableURL.path);
        var appName = text(application.localizedName).toLowerCase();
        var identifier = text(application.bundleIdentifier).toLowerCase();
        var filename = appExecutable.split('/').pop().toLowerCase();
        if ((executable && appExecutable === executable) || (hint && (appName === hint || filename === hint || identifier === hint))) {
          target = text(application.bundleURL.path) || appExecutable;
          break;
        }
      } catch (_) {}
    }
  }
  if (!target && hint && name.indexOf('/') < 0 && name.indexOf('\\') < 0 && name !== '.' && name !== '..') {
    var appFilename = /\.app$/i.test(name) ? name : name + '.app';
    var candidates = ['/Applications/', '/System/Applications/', '/System/Applications/Utilities/', text($.NSHomeDirectory()) + '/Applications/'];
    for (var j = 0; j < candidates.length; j++) {
      if (files.fileExistsAtPath($(candidates[j] + appFilename))) { target = candidates[j] + appFilename; break; }
    }
  }
  if (!target && executable && files.fileExistsAtPath($(executable))) target = executable;
  if (!target) return '';
  bundle = target.match(/^(.+?\.app)(?:\/|$)/i);
  if (bundle) target = bundle[1];
  var original = workspace.iconForFile($(target));
  if (!original) return '';
  var resized = $.NSImage.alloc.initWithSize($.NSMakeSize(64, 64));
  resized.lockFocus;
  original.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, 64, 64), $.NSZeroRect, $.NSCompositeSourceOver, 1);
  resized.unlockFocus;
  var bitmap = $.NSBitmapImageRep.imageRepWithData(resized.TIFFRepresentation);
  var png = bitmap.representationUsingTypeProperties($.NSPNGFileType, $.NSDictionary.dictionary);
  return text(png.base64EncodedStringWithOptions(0));
}
"#;

#[cfg(any(target_os = "macos", test))]
pub(crate) fn mac_icon_data_url(input: &str, name: Option<&str>) -> Result<Option<String>, String> {
    use std::{
        io::Read,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    let path = if input.starts_with('/') {
        std::fs::canonicalize(input)
            .ok()
            .map(|path| path.to_string_lossy().into_owned())
    } else {
        None
    };
    let path = path
        .as_deref()
        .and_then(mac_app_bundle)
        .or(path)
        .unwrap_or_default();
    let hint = name
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| input.rsplit('/').next().unwrap_or(input));
    // Fixed script and environment arguments: process names/paths are never code.
    let mut child = Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript", "-e", ICON_SCRIPT])
        .env("FLYCLASH_ICON_PATH", path)
        .env("FLYCLASH_ICON_NAME", hint)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;
    // Drain stdout while the child runs so even a detailed icon cannot fill its pipe.
    let stdout = child.stdout.take().ok_or("icon_stdout_unavailable")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take(512 * 1024)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if start.elapsed() < Duration::from_secs(8) => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let bytes = reader
        .join()
        .map_err(|_| "icon_reader_failed")?
        .map_err(|error| error.to_string())?;
    if !status.is_some_and(|status| status.success()) {
        return Ok(None);
    }
    let encoded = String::from_utf8_lossy(&bytes).trim().to_string();
    if !encoded.starts_with("iVBORw0KGgo") || encoded.len() > 256 * 1024 {
        return Ok(None);
    }
    Ok(Some(format!("data:image/png;base64,{encoded}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selects_the_outer_application_bundle() {
        let _signature =
            mac_icon_data_url as fn(&str, Option<&str>) -> Result<Option<String>, String>;
        assert_eq!(
            mac_app_bundle(
                "/Applications/Browser.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper"
            )
            .as_deref(),
            Some("/Applications/Browser.app")
        );
        assert_eq!(
            mac_app_bundle(
                "/private/var/folders/test/AppTranslocation/id/d/My App.app/Contents/MacOS/app"
            )
            .as_deref(),
            Some("/private/var/folders/test/AppTranslocation/id/d/My App.app")
        );
        assert!(mac_app_bundle("/usr/bin/curl").is_none());
        assert!(mac_app_bundle("https://example.com/App.app").is_none());
        assert!(mac_app_bundle("/Applications/App.app/../Other").is_none());
    }
    #[test]
    fn identifies_own_process_without_matching_unrelated_names() {
        assert!(is_self_process(
            "/Applications/FlyClash.app/Contents/MacOS/FlyClash",
            None
        ));
        assert!(is_self_process("", Some("FlyClash")));
        assert!(is_self_process("mihomo", None));
        assert!(!is_self_process("/tmp/other", Some("NotFlyClash")));
    }
}

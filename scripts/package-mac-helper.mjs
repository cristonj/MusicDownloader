import { execFileSync } from "node:child_process";
import { mkdir, cp, writeFile } from "node:fs/promises";
const app = "helper-dist/MusicDownloader Helper.app";
// Use an Apple-provided application launcher and keep each pkg binary intact.
// Combining pkg payloads with lipo would invalidate their embedded offsets.
const script =
  'on run\nset appPath to POSIX path of (path to me)\nset commandPath to appPath & "Contents/Resources/bin/launch"\ndo shell script quoted form of commandPath & " > /dev/null 2>&1 &"\nend run';
await writeFile(".helper-build/launch.applescript", script);
execFileSync("osacompile", ["-o", app, ".helper-build/launch.applescript"], {
  stdio: "inherit",
});
await mkdir(`${app}/Contents/Resources/bin`, { recursive: true });
for (const arch of ["x64", "arm64"])
  await cp(
    `helper-dist/MusicDownloader-Helper-darwin-${arch}`,
    `${app}/Contents/Resources/bin/helper-${arch}`,
  );
await writeFile(
  `${app}/Contents/Resources/bin/launch`,
  '#!/bin/sh\nhelper_dir="$(dirname "$0")"\ncase "$(uname -m)" in arm64) exec "$helper_dir/helper-arm64" ;; *) exec "$helper_dir/helper-x64" ;; esac\n',
  { mode: 0o755 },
);
execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], {
  stdio: "inherit",
});
execFileSync(
  "ditto",
  [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    app,
    "helper-dist/MusicDownloader-Helper-Mac.zip",
  ],
  { stdio: "inherit" },
);

import { execFileSync } from "node:child_process";
import { join } from "node:path";

const moduleBinary = (...segments) => join(process.cwd(), "node_modules", ...segments);

execFileSync(process.execPath, [moduleBinary("typescript", "bin", "tsc"), "--noEmit"], {
  stdio: "inherit"
});
execFileSync(process.execPath, [moduleBinary("vite", "bin", "vite.js"), "build"], {
  stdio: "inherit"
});

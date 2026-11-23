import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = join(root, "target");
const exe = process.platform === "win32" ? "wasmedge-agent.exe" : "wasmedge-agent";
execFileSync("cargo", ["build", "--locked", "--release", "-p", "pa-cli", "--bin", "wasmedge-agent", "--target-dir", target], {
	cwd: root, stdio: "inherit",
});
const dest = join(root, "packages/coding-agent/dist/native", `${process.platform}-${process.arch}`);
mkdirSync(dest, { recursive: true });
copyFileSync(join(target, "release", exe), join(dest, exe));

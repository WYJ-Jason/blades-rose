import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dataDirectory = process.env.DATA_DIR ?? join(process.cwd(), "data");
mkdirSync(dataDirectory, { recursive: true });

const publicUrlFile = join(dataDirectory, "public-url.txt");
const child = spawn(
  "npx",
  ["--yes", "cloudflared", "tunnel", "--protocol", "http2", "--url", "http://localhost:3000"],
  { shell: true, stdio: ["ignore", "pipe", "pipe"] }
);

const onOutput = (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (!match) return;
  writeFileSync(publicUrlFile, match[0], "utf8");
  console.log(`\n公网加入地址已写入：${match[0]}`);
  console.log("刷新房主页面后，二维码会使用这个地址。不同网络的玩家也能加入。\n");
};

child.stdout.on("data", onOutput);
child.stderr.on("data", onOutput);
child.on("exit", (code) => {
  process.exit(code ?? 0);
});

/** The dummy repo that every scenario runs in: generated files only, the same bytes on every run. */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

export const FIXTURE_IDENTITY = { name: "Fixture", email: "fixture@example.invalid" } as const;

/** Write the dummy repo into `dir` and commit it with the fixture identity and a fixed date. */
export function writeDummyRepo(dir: string, env: NodeJS.ProcessEnv): void {
  const files: Record<string, string | Buffer> = {
    "README.md": "# Fixture repo\n\nA small generated project for recording Claude Code sessions.\n",
    "src/math.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n\n// TODO: add subtract\n",
    "src/greet.ts": "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n",
    "src/big.txt": bigText(),
    "notes.txt": "Meeting notes\n- ship the parser\n- write the docs\n- plan the demo\n",
    "diagram.png": stripesPng(96, 64),
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const date = "2026-01-01T00:00:00Z";
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      stdio: "pipe",
    });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "Add the fixture project");
}

/** About 20 kB of numbered lines, for a large Read. */
function bigText(): string {
  const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
  const lines: string[] = [];
  for (let i = 1; i <= 300; i++) {
    const picked = Array.from({ length: 8 }, (_, k) => words[(i * 3 + k * 5) % words.length]);
    lines.push(`Line ${String(i).padStart(4, "0")}: ${picked.join(" ")}.`);
  }
  return `${lines.join("\n")}\n`;
}

/** A PNG of three vertical stripes (red, green, blue), 8-bit RGB, built with zlib only. */
export function stripesPng(width: number, height: number): Buffer {
  const colors = [
    [220, 40, 40],
    [40, 180, 60],
    [40, 80, 220],
  ] as const;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1); // filter byte 0 (none), then the pixels
    for (let x = 0; x < width; x++) {
      const color = colors[Math.min(2, Math.floor((x * 3) / width))] ?? colors[0];
      raw.set(color, row + 1 + x * 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // bit depth 8, colour type RGB
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

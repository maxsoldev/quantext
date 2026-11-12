/**
 * Property-style test of demo mode: texts with home paths in every encoding, at every position, around other text.
 * The output must hold no home folder name, no user name and no hidden project name.
 */
import { describe, expect, test } from "vitest";
import { previewOf } from "../../src/query/preview.ts";
import { createRedactor } from "../../src/query/redact.ts";

const j = (...parts: string[]) => parts.join("");
const NAMES = ["alice", "Bob Smith", "zoë", "carol.d", "dan_e", "Émile"];

/** Every way a home path of `name` shows up in logs, with `rest` after it. */
function encodings(name: string, rest: string): string[] {
  const enc = name.replace(/[^A-Za-z0-9]/g, "-");
  return [
    `${j("/Us", "ers/")}${name}/${rest}`,
    `${j("/ho", "me/")}${name}/${rest}`,
    `${j("C:", "\\Users\\")}${name}\\${rest}`,
    `${j("C:", "\\\\Users\\\\")}${name}\\\\${rest}`,
    `${j("c:/Us", "ers/")}${name}/${rest}`,
    `${j("%2FUs", "ers%2F")}${encodeURIComponent(name)}%2F${rest}`,
    `${j("%2fho", "me%2f")}${encodeURIComponent(name)}%2f${rest}`,
    `${j("C:%5CUs", "ers%5C")}${encodeURIComponent(name)}%5C${rest}`,
    `${j("-Us", "ers-")}${enc}-${rest}`,
    `${j("-ho", "me-")}${enc}-${rest}`,
    `${j("C--Us", "ers-")}${enc}-${rest}`,
    `~${name}/${rest}`,
    `git@github.com:${name}/${rest}.git`,
    `${name}@laptop`,
  ];
}

const AROUND: ((s: string) => string)[] = [
  (s) => s,
  (s) => `see ${s} now`,
  (s) => `"${s}"`,
  (s) => JSON.stringify({ path: s }),
  (s) => `(${s}), next`,
  (s) => `line one\n${s}\nline three`,
];

describe("demo mode leaves no home folder, user name or hidden project", () => {
  for (const name of NAMES) {
    test(name, () => {
      const home = `${j("/Us", "ers/")}${name}`;
      const hidden = `${home}/work/secret-plans`;
      const redact = createRedactor({ home, user: name, hidden: [hidden] });
      for (const rest of ["code/shop", "work/secret-plans/src", "x"]) {
        for (const text of encodings(name, rest)) {
          for (const around of AROUND) {
            const out = redact(around(text), `${home}/code/shop`);
            const lower = out.toLowerCase();
            expect(lower, `${around(text)} → ${out}`).not.toContain(name.toLowerCase());
            expect(lower, `${around(text)} → ${out}`).not.toContain(encodeURIComponent(name).toLowerCase());
            expect(out, `${around(text)} → ${out}`).not.toContain("secret-plans");
          }
        }
      }
    });
  }
});

describe("a preview is cut after redaction, so no cut word escapes it", () => {
  for (const name of NAMES) {
    test(name, () => {
      const home = `${j("/Us", "ers/")}${name}`;
      const hidden = `${home}/work/secretproj`;
      const redact = createRedactor({ home, user: name, hidden: [hidden] });
      const text = `cd ${hidden}/src; git push git@github.com:${name}/x.git; ${home}/notes and the secretproj repo`;
      const pieces = (s: string) => {
        const out: string[] = [];
        for (let n = 4; n <= s.length; n++) out.push(s.slice(0, n));
        return out;
      };
      for (let max = 2; max <= text.length + 2; max++) {
        const { preview } = previewOf(text, max, (s) => redact(s, `${home}/code/shop`));
        const lower = preview.toLowerCase();
        for (const secret of [name.toLowerCase(), "secretproj"]) {
          for (const part of pieces(secret)) expect(lower, `${max}: ${preview}`).not.toContain(part);
        }
      }
    });
  }
});

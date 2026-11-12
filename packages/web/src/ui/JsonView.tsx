/**
 * A collapsible JSON tree (adapted from the eduagent visualiser). The arrow opens a node and all below it; the key
 * or the "N keys" summary opens one level. Long strings are cut, with a button for the rest.
 */
import type { JsonValue } from "@quantext/shared";
import { useState } from "react";

const CUT = 600;

export function JsonView({
  value,
  depth = 0,
  open = 2,
  label,
  all = false,
}: {
  value: JsonValue;
  depth?: number;
  open?: number;
  label?: string;
  all?: boolean;
}) {
  const [expanded, setExpanded] = useState(all || depth < open);
  const [deep, setDeep] = useState(all);
  const key = label !== undefined && <span className="j-key">{label}: </span>;
  if (value === null || typeof value !== "object") {
    return (
      <>
        {key}
        <Scalar value={value} />
      </>
    );
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
  const [l, r] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  if (entries.length === 0) {
    return (
      <>
        {key}
        <span className="j-punct">{l + r}</span>
      </>
    );
  }
  const toggle = (recursive: boolean) => {
    setDeep(recursive && !expanded);
    setExpanded(!expanded);
  };
  return (
    <span>
      {label !== undefined && (
        <button type="button" className="j-key j-plain" onClick={() => toggle(false)}>
          {label}:{" "}
        </button>
      )}
      <button type="button" className="j-toggle" onClick={() => toggle(true)} aria-expanded={expanded}>
        {expanded ? "▾" : "▸"}
      </button>
      <span className="j-punct">{l}</span>
      {!expanded && (
        <button type="button" className="j-summary j-plain" onClick={() => toggle(false)}>
          {entries.length} {Array.isArray(value) ? "items" : "keys"}
        </button>
      )}
      {expanded && (
        <div className="j-body">
          {entries.map(([k, v]) => (
            <div key={k}>
              <JsonView
                value={v}
                depth={depth + 1}
                open={open}
                all={deep}
                {...(Array.isArray(value) ? {} : { label: k })}
              />
            </div>
          ))}
        </div>
      )}
      <span className="j-punct">{r}</span>
    </span>
  );
}

function Scalar({ value }: { value: JsonValue }) {
  const [full, setFull] = useState(false);
  if (typeof value === "string") {
    const cut = value.length > CUT && !full;
    return (
      <span className="j-str">
        "{cut ? value.slice(0, CUT) : value}"
        {value.length > CUT && (
          <button type="button" className="j-more" onClick={() => setFull(!full)}>
            {full ? "less" : `${(value.length - CUT).toLocaleString("en-US")} more characters`}
          </button>
        )}
      </span>
    );
  }
  return <span className={`j-${typeof value}`}>{String(value)}</span>;
}

import { useState } from "react";
import { useStore } from "../state";
import { mcpUrl } from "../workspace";
import { CloseIcon } from "./icons";
import { copyText, CopyButton } from "./shell/Shell";

const CLIENTS = ["Claude Code", "Claude Desktop", "Cursor", "Other"] as const;
type ClientName = (typeof CLIENTS)[number];

function setup(client: ClientName, url: string): { code: string; note: string } {
  switch (client) {
    case "Claude Code":
      return { code: `claude mcp add --transport http not-a-cad ${url}`, note: "Run this in a terminal, then start claude in any folder." };
    case "Claude Desktop":
      return { code: url, note: "Settings → Connectors → Add custom connector, then paste this URL." };
    case "Cursor":
      return { code: JSON.stringify({ mcpServers: { cad: { url } } }, null, 2), note: "Add to ~/.cursor/mcp.json and reload Cursor." };
    default:
      return { code: url, note: "Any MCP client with Streamable HTTP and sign-in (OAuth). Use this URL as the server address." };
  }
}

export const EXAMPLE_PROMPTS = [
  "Make a parametric wall bracket for a 200 mm shelf with M5 screw holes",
  "Design a cable clip for 6 mm cables. Expose the diameter as a parameter.",
  "Build a two-part enclosure for a 60 × 40 mm PCB with a snap-fit lid",
];

// Empty project: connect an agent, then ask for a part; gone once a part exists
export function Onboarding() {
  const agents = useStore((s) => s.agents);
  const restored = useStore((s) => s.restored);
  const hasParts = useStore((s) => Object.keys(s.parts).length > 0);
  const [client, setClient] = useState<ClientName>("Claude Code");
  const [copied, setCopied] = useState<number>();
  const [closed, setClosed] = useState(false);
  if (!restored || hasParts || closed) return null;
  const connected = agents.some((a) => a.connected);
  const s = setup(client, mcpUrl());
  const copyPrompt = async (i: number) => {
    await copyText(EXAMPLE_PROMPTS[i]);
    setCopied(i);
    setTimeout(() => setCopied(undefined), 1500);
  };
  const agent = agents.find((a) => a.connected)?.name ?? "Your agent";
  return (
    <div className="empty-card">
      <div className="card" data-testid="onboarding" data-step={connected ? 2 : 1}>
        <button className="btn btn-ghost btn-icon close" aria-label="Close" title="Close (the agent pill has the setup too)" onClick={() => setClosed(true)}><CloseIcon /></button>
        {connected ? (
          <>
            <div className="mono-label">{agent.toUpperCase()} IS CONNECTED</div>
            <h2>Ask for a part</h2>
            <p className="lead" style={{ marginBottom: 4 }}>
              Describe it in your agent's chat. Name the sizes you care about and ask it to expose them as parameters.
            </p>
          </>
        ) : (
          <>
            <div className="mono-label">STEP 1 OF 2</div>
            <h2>Connect your agent</h2>
            <p className="lead">
              <span className="nobr">not-a-cad</span> doesn't have drawing tools. Your agent builds the model over MCP and this tab shows it. You approve the agent once, when it first connects.
            </p>
            <div className="client-tabs" role="tablist">
              {CLIENTS.map((c) => (
                <button key={c} className="btn" role="tab" aria-selected={c === client} onClick={() => setClient(c)}>{c}</button>
              ))}
            </div>
            <div className="snippet"><pre data-testid="setup-snippet">{s.code}</pre><CopyButton text={s.code} /></div>
            <p className="note">{s.note}</p>
            <div className="waiting" data-testid="waiting"><span className="dot" />Waiting for an agent to connect…</div>
          </>
        )}
        <div className="prompts-title">Example prompts</div>
        <div className="prompts">
          {EXAMPLE_PROMPTS.map((p, i) => (
            <button key={i} className="btn btn-block" onClick={() => copyPrompt(i)}><span className="t">{p}</span><span className="mono">{copied === i ? "COPIED" : "COPY"}</span></button>
          ))}
        </div>
      </div>
    </div>
  );
}

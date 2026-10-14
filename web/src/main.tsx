import { createRoot } from "react-dom/client";
import { keepWorkspaceInUrl, libraryPath, parse, projectPath, useRoute } from "./route";
import { newWorkspace, remember, remembered } from "./workspace";
import "./ui/css/tokens.css";
import "./ui/css/buttons.css";
import "./ui/css/tools.css";
import "./ui/css/shell.css";
import "./ui/css/panels.css";
import "./ui/css/pages.css";

const root = createRoot(document.getElementById("root")!);

function NotFound() {
  return (
    <div className="notfound" data-testid="not-found">
      <div className="in">
        <div className="mono-label">{location.pathname}</div>
        <h1>This page doesn't exist</h1>
        <p>The link may be mistyped.</p>
        <a className="btn btn-lg btn-primary" href="/">Open not-a-cad</a>
      </div>
    </div>
  );
}

async function start() {
  let route = parse(location.pathname);
  // Share viewer never loads the workspace code (no workspace id, no socket)
  if (route.kind === "share") {
    const { ShareApp } = await import("./ui/ShareApp");
    return root.render(<ShareApp shareId={route.id} />);
  }
  if (route.kind === "notfound") return root.render(<NotFound />);
  if (route.kind === "connect") {
    const { ConnectPage } = await import("./ui/ConnectPage");
    return root.render(<ConnectPage id={route.id} />);
  }
  let ws: string;
  if (route.kind === "link") {
    // Bookmark link: remember the workspace, then drop it from the address bar
    ws = route.ws;
    remember(ws);
    if (remembered() !== ws) keepWorkspaceInUrl(ws);
    const clean = route.pid ? projectPath(route.pid) : libraryPath();
    history.replaceState(null, "", clean + location.search + location.hash);
    route = parse(clean);
    useRoute.setState({ route });
  } else {
    ws = remembered() ?? (await newWorkspace());
    remember(ws);
    if (remembered() !== ws) {
      keepWorkspaceInUrl(ws);
      const inUrl = route.kind === "project" ? projectPath(route.pid) : libraryPath();
      history.replaceState(null, "", inUrl + location.search + location.hash);
      useRoute.setState({ route: parse(inUrl) });
    }
  }
  if (route.kind !== "library" && route.kind !== "project") return;
  const [{ startLive }, { WorkspaceApp }] = await Promise.all([import("./live"), import("./ui/Workspace")]);
  startLive(ws);
  root.render(<WorkspaceApp ws={ws} />);
}

start().catch((e) => root.render(<div className="notfound"><div className="in"><h1>Could not start</h1><p>{String(e)}</p></div></div>));

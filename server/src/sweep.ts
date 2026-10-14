import type { ActivityLog } from "./activity";
import type { AuthStore } from "./auth";
import type { BundleStore } from "./bundles";
import type { ShareStore } from "./shareStore";
import type { Store } from "./store";

// Expiry and purge; purged projects lose their shares and mesh bundles
export async function sweepAll(store: Store, shares: ShareStore, bundles: BundleStore, extra: { auth?: AuthStore; activity?: ActivityLog } = {}) {
  await extra.auth?.sweep();
  await extra.activity?.sweep();
  const { projects, workspaces } = await store.sweep();
  for (const pid of projects) {
    const sid = await shares.unpublish(pid);
    if (sid) await bundles.delete(sid);
  }
  return { projects: projects.length, workspaces, shares: await shares.sweep(), bundles: await bundles.sweep() };
}

// dsh-workspace-files — node half: no-op host entry so a cordis row can mount
// the browser bundle (same shape as dsh-todo-float / dsh-hide-buttons). All
// behaviour lives in ./client.js, which the client module system serves to the
// Web GUI.
export const name = "dsh-workspace-files";
export const inject = [];
export function apply() {
	// Probe line: proves the loader row mounted (and gives the client-module
	// scanner a live fiber to reconcile against).
	console.log("[dsh-workspace-files] host half mounted");
}

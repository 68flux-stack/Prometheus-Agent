const { contextBridge, ipcRenderer, webUtils } = require("electron");

function subscribe(channel) {
	return (listener) => {
		const wrapped = (_event, payload) => listener(payload);
		ipcRenderer.on(channel, wrapped);
		return () => ipcRenderer.removeListener(channel, wrapped);
	};
}

contextBridge.exposeInMainWorld("desktopAgent", {
	start: (options) => ipcRenderer.invoke("agent:start", options),
	stop: () => ipcRenderer.invoke("agent:stop"),
	send: (command) => ipcRenderer.invoke("agent:send", command),
	saveProviderApiKey: (payload) => ipcRenderer.invoke("provider:save-api-key", payload),
	loginProvider: (payload) => ipcRenderer.invoke("provider:login", payload),
	cancelProviderLogin: () => ipcRenderer.invoke("provider:login-cancel"),
	respondProviderLoginPrompt: (payload) => ipcRenderer.invoke("provider:login-prompt-response", payload),
	listSessions: (payload) => ipcRenderer.invoke("sessions:list", payload),
	readSessionMessages: (payload) => ipcRenderer.invoke("sessions:read", payload),
	listSessionSubagents: (payload) => ipcRenderer.invoke("sessions:subagents", payload),
	getTheme: () => ipcRenderer.invoke("theme:get"),
	getPaths: () => ipcRenderer.invoke("agent:paths"),
	getDefaultWorkspace: () => ipcRenderer.invoke("workspace:default"),
	listWorkspaces: () => ipcRenderer.invoke("workspace:list"),
	saveWorkspaces: (payload) => ipcRenderer.invoke("workspace:save", payload),
	createWorkspaceSession: (payload) => ipcRenderer.invoke("workspace:create-session", payload),
	chooseWorkspace: () => ipcRenderer.invoke("workspace:choose"),
	chooseFiles: () => ipcRenderer.invoke("files:choose"),
	// Electron 32+ dropped File.path; this is the supported replacement.
	getFilePath: (file) => webUtils.getPathForFile(file),
	savePastedImage: (payload) => ipcRenderer.invoke("files:save-pasted-image", payload),
	startDictation: () => ipcRenderer.invoke("dictation:start"),
	openPath: (target) => ipcRenderer.invoke("shell:open-path", target),
	openExternal: (target) => ipcRenderer.invoke("shell:open-external", target),
	onEvent: subscribe("agent:event"),
	onStarted: subscribe("agent:started"),
	onError: subscribe("agent:error"),
	onLog: subscribe("agent:stderr"),
	onExit: subscribe("agent:exit"),
	onProviderLoginEvent: subscribe("provider:login-event"),
});

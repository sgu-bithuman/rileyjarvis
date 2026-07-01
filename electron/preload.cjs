const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("ricky", {
  createRealtimeToken: () => ipcRenderer.invoke("realtime:create-token"),
  executeTool: (toolCall) => ipcRenderer.invoke("tools:execute", toolCall),
  getToolSpecs: () => ipcRenderer.invoke("tools:list"),
  // Pushed from the main process while a long tool (computer_task) runs.
  onPushArtifact: (callback) => subscribe("ricky:push-artifact", callback),
  onPushTranscript: (callback) => subscribe("ricky:push-transcript", callback),
  onSetMode: (callback) => subscribe("ricky:set-mode", callback),
});

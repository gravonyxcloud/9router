export default {
  id: "opencode-sidecar",
  priority: 45,
  hasFree: true,
  alias: "osc",
  aliases: ["opencode-sidecar"],
  uiAlias: "osc",
  display: {
    name: "OpenCode Sidecar",
    icon: "terminal",
    color: "#22C55E",
    textIcon: "OS",
    website: "https://opencode.ai",
    notice: {
      text: "Runs the genuine opencode CLI binary locally per request (needs `opencode auth login`). Agent file/shell tools execute inside an isolated sandbox dir. Text-in/text-out: client tool-calling is not bridged.",
    },
  },
  category: "free",
  authType: "none",
  noAuth: true,
  authModes: ["none"],
  transport: {
    baseUrl: "sidecar://opencode/run",
    format: "openai",
    noAuth: true,
  },
  models: [
    { id: "big-pickle", name: "Big Pickle (Free)" },
    { id: "cat-jam-free", name: "Cat Jam Free" },
  ],
  serviceKinds: ["llm"],
  passthroughModels: true,
};

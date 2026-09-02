// Local-directory entrypoint (opencode.json `plugins` may point at this
// repo checkout as a path target). Re-exports the server plugin.
export { default } from "./.opencode/plugins/litellm.js"
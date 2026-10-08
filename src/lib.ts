// Library entry point for apps that run the server inside their own Node process.
// See docs/embedding.md.
export { loadConfig, defaultDataDir, defaultSettingsPath, ConfigError, ENV, type SKaupatConfig, type LoadConfigOptions } from "./config.js";
export { createRuntime, type SKaupatRuntime } from "./runtime.js";
export { startHttpServer, type HttpOptions, type RunningHttpServer } from "./http.js";
export { OrderReviews } from "./checkout/reviews.js";
export { createServer, SERVER_NAME, SERVER_VERSION, SCHEMA_VERSION, SERVER_INSTRUCTIONS } from "./server.js";
export {
  ERROR_ACTIONS,
  USER_MESSAGES,
  SKaupatError,
  type ErrorAction,
  type ErrorCode,
  type UserMessage,
} from "./errors.js";

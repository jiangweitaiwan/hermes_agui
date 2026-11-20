// Mounted only by the local image probe; never copied into a production image.
import { createRequire } from "node:module";
if (process.env.NODE_ENV !== "test") throw new Error("Local SDK probe requires NODE_ENV=test");
const { GoogleAuth } = createRequire("/app/package.json")("google-auth-library");
GoogleAuth.prototype.getClient = async () => ({
  request: async () => { throw new Error("External Google API calls are blocked by the local startup probe"); },
});


// Provided by the Cloudflare Workers runtime; it is not a standard TypeScript module.
// @ts-expect-error - "cloudflare:node" is a Workers-only virtual module unknown to tsc
import { httpServerHandler } from "cloudflare:node";
import { app, registerTerminalHandlers } from "./app";

// Register Express 404 and error handlers.
registerTerminalHandlers(app);

// Start the Express application on the Workers HTTP adapter.
app.listen(3000);

// Expose Express through the Cloudflare Workers runtime.
export default httpServerHandler({ port: 3000 });

import process from "node:process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "./config.js";
import { startGatewayServer as startGatewayServerImpl } from "./server.impl.js";
export { startGatewayServer } from "./server.impl.js";
async function main() {
    try {
        await startGatewayServerImpl(config.port, { host: config.host });
    }
    catch (error) {
        console.error(error instanceof Error
            ? `Failed to start gateway: ${error.message}`
            : "Failed to start gateway due to an unknown error.");
        process.exit(1);
    }
}
const invokedAsScript = (() => {
    const scriptArg = process.argv[1];
    if (!scriptArg) {
        return false;
    }
    return pathToFileURL(path.resolve(scriptArg)).href === import.meta.url;
})();
if (invokedAsScript) {
    void main();
}

import { config } from "./config.js";
import { createGatewayHttpServer } from "./server-http.js";
export async function startGatewayServer(port = config.port, opts = {}) {
    const host = opts.host ?? config.host;
    const server = createGatewayHttpServer();
    await new Promise((resolve, reject) => {
        const onError = (error) => {
            server.off("listening", onListening);
            reject(error);
        };
        const onListening = () => {
            server.off("error", onError);
            resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen({
            host,
            port,
        });
    });
    const address = server.address();
    const resolvedPort = typeof address === "object" && address ? address.port : port;
    console.log(`Gateway listening on http://${host}:${resolvedPort}`);
    return {
        close: async () => {
            await new Promise((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
        },
    };
}

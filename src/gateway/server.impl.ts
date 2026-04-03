import type { AddressInfo } from "node:net";
import { config } from "./config.js";
import { createGatewayHttpServer } from "./server-http.js";

export type GatewayServer = {
  close: (opts?: { reason?: string }) => Promise<void>;
};

export type GatewayServerOptions = {
  host?: string;
};

export async function startGatewayServer(
  port = config.port,
  opts: GatewayServerOptions = {},
): Promise<GatewayServer> {
  const host = opts.host ?? config.host;
  const server = createGatewayHttpServer();

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
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
  const resolvedPort = typeof address === "object" && address ? (address as AddressInfo).port : port;

  console.log(`Gateway listening on http://${host}:${resolvedPort} -> ${config.upstreamBaseUrl}`);

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
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

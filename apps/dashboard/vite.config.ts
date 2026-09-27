import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

const API_TARGET = "http://localhost:8787";

/**
 * The dev server proxies everything the MCP server owns. The Origin header is rewritten to the target so the
 * server's CSRF check (Origin must match PUBLIC_BASE_URL) accepts mutating requests made from the Vite port.
 */
const toServer: ProxyOptions = {
  target: API_TARGET,
  changeOrigin: true,
  configure: (proxy) => {
    proxy.on("proxyReq", (proxyReq) => {
      if (proxyReq.getHeader("origin")) proxyReq.setHeader("origin", API_TARGET);
    });
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": toServer,
      "/mcp": toServer,
      "/artifacts": toServer,
      "/v/": toServer,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});

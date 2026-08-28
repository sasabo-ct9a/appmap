import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 制作モードのプレビュー用。AppMap が固定ポートで開くので strictPort。
// host は 127.0.0.1 に固定:既定の localhost は Windows で IPv6(::1)を掴み、
// AppMap 側の起動確認(127.0.0.1)や iframe と食い違って「起動しない」誤判定になるため。
export default defineConfig({
  plugins: [react()],
  server: { port: 5199, strictPort: true, host: "127.0.0.1" },
});

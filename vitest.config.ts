/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * v0.1.8:Vitest 設定。
 *   - jsdom 環境で React コンポーネントもテスト可
 *   - globals: true で describe / it / expect を import なしで使える
 *   - setupFiles で @testing-library/jest-dom の matcher を全テストに注入
 *   - src-tauri の Rust テストとは別軸(こちらは JS/TS のみ)
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules", "dist", "src-tauri"],
  },
});

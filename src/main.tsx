import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { CanvasWindow } from "./components/create/CanvasWindow";
import "./index.css";

// URL ハッシュが #canvas のウィンドウは「キャンバス専用ウィンドウ」を描く(制作モードの別画面全画面)。
const isCanvas =
  window.location.hash.replace(/^#/, "").split(/[?&]/)[0] === "canvas";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isCanvas ? <CanvasWindow /> : <App />}</React.StrictMode>,
);

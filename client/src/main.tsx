import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";

// 桌面化行为：禁用网页右键菜单（输入框内保留，便于复制/粘贴）
document.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement | null;
  if (!target?.closest("input, textarea")) e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

// Lets the stylesheet reserve room for the overlay window controls.
if ("__TAURI_INTERNALS__" in window) {
  document.documentElement.classList.add("tauri");
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { initMonitoring, logAppError } from "./monitoring.js";

initMonitoring();

if (typeof window !== "undefined") {
  window.addEventListener("error", (event) => {
    logAppError(event?.error || event?.message || "window.error", "window.error", {
      filename: event?.filename,
      line: event?.lineno,
      column: event?.colno,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    logAppError(event?.reason || "Unhandled promise rejection", "window.unhandledrejection");
  });
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);

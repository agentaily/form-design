import React from "react";
import { createRoot } from "react-dom/client";

// Design-system tokens + global styles (fonts, colors, motif utilities). Load once.
import "@agentaily/design-system/styles.css";
// Layout-only styles for this app's page chrome.
import "./app.css";

import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

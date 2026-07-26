import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { CompanionApp } from "./CompanionApp.jsx";
import { AppErrorBoundary } from "./ui.jsx";
import "./styles.css";
import "./ui.css";

const RootApp = window.location.pathname === "/companion" ? CompanionApp : App;

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <RootApp />
    </AppErrorBoundary>
  </React.StrictMode>,
);

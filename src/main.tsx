import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/space-grotesk";
import "@fontsource/ibm-plex-mono";
import "./theme/tokens.css";
import { App } from "./App";
createRoot(document.getElementById("root")!).render(<App />);

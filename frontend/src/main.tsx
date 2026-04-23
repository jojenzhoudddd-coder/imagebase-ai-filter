import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "./index.css";
import App from "./App";
import { ToastProvider } from "./components/Toast/index";
import { LanguageProvider } from "./i18n/index";

/**
 * Router layout (all artifacts get readable URLs — see docs/vibe-demo-plan.md §3):
 *   /                                                      → redirect to doc_default
 *   /workspace/:workspaceId                                 → <App />, no focus
 *   /workspace/:workspaceId/:artifactType/:artifactId       → <App /> with focus
 *     artifactType ∈ {table, idea, design, demo, conversation}
 *
 * <App /> reads useParams and drives its existing state (activeTableId /
 * activeItemType) from the URL. Calls to navigate() propagate the other
 * direction. /share/:slug lives on the backend, not the SPA.
 */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <LanguageProvider>
        <ToastProvider>
          <Routes>
            <Route path="/" element={<Navigate to="/workspace/doc_default" replace />} />
            <Route path="/workspace/:workspaceId" element={<App />} />
            <Route path="/workspace/:workspaceId/:artifactType/:artifactId" element={<App />} />
            <Route path="*" element={<App />} />
          </Routes>
        </ToastProvider>
      </LanguageProvider>
    </BrowserRouter>
  </StrictMode>
);

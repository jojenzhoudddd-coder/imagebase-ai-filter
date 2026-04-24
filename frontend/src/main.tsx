import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "./index.css";
import App from "./App";
import { ToastProvider } from "./components/Toast/index";
import { LanguageProvider } from "./i18n/index";
import { AuthProvider } from "./auth/AuthContext";
import LoginPage from "./auth/LoginPage";
import RegisterPage from "./auth/RegisterPage";
import RequireAuth from "./auth/RequireAuth";

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
          <AuthProvider>
            <Routes>
              {/* Public routes */}
              <Route path="/login" element={<LoginPage />} />
              <Route path="/register" element={<RegisterPage />} />

              {/* Everything else requires auth. `RequireAuth` bounces to
                  /login when the /me check says logged out. */}
              <Route path="/" element={
                <RequireAuth>
                  <Navigate to="/workspace/doc_default" replace />
                </RequireAuth>
              } />
              <Route path="/workspace/:workspaceId" element={
                <RequireAuth><App /></RequireAuth>
              } />
              <Route path="/workspace/:workspaceId/:artifactType/:artifactId" element={
                <RequireAuth><App /></RequireAuth>
              } />
              <Route path="*" element={
                <RequireAuth><App /></RequireAuth>
              } />
            </Routes>
          </AuthProvider>
        </ToastProvider>
      </LanguageProvider>
    </BrowserRouter>
  </StrictMode>
);

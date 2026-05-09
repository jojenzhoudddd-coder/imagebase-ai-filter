import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
import "./index.css";
import App from "./App";
import { ToastProvider } from "./components/Toast/index";
import { LanguageProvider } from "./i18n/index";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import LoginPage from "./auth/LoginPage";
import RegisterPage from "./auth/RegisterPage";
import RequireAuth from "./auth/RequireAuth";

/**
 * RedirectToOwnWorkspace —— 登录后访问 "/"，把用户导到**他自己**的第一个
 * workspace。之前这里硬写了 "/workspace/doc_default"，导致任何登录用户
 * 都会进入历史 seed 的空间、看到里面所有数据——严重隐私漏洞。
 */
function RedirectToOwnWorkspace() {
  const { workspaceId, loading } = useAuth();
  if (loading) return null;
  if (!workspaceId) {
    // 理论上 register/login 后 AuthContext 一定有 workspaceId；兜底保护。
    return <div style={{ padding: 40 }}>No workspace available for this user.</div>;
  }
  return <Navigate to={`/workspace/${workspaceId}`} replace />;
}

/**
 * Backward-compat redirect: old URLs with artifact segments
 * (`/workspace/:wsId/table/:id`) strip the artifact part and redirect to
 * `/workspace/:wsId`. Artifact focus is now restored from localStorage /
 * canvasLayout preferences, not the URL.
 */
function RedirectStripArtifact() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  return <Navigate to={`/workspace/${workspaceId}`} replace />;
}

/**
 * Router layout:
 *   /                                → redirect to user's own workspace
 *   /workspace/:workspaceId          → <App />
 *   /workspace/:wsId/:type/:id       → redirect to /workspace/:wsId (legacy)
 *
 * /share/:slug lives on the backend, not the SPA.
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
                  <RedirectToOwnWorkspace />
                </RequireAuth>
              } />
              <Route path="/workspace/:workspaceId" element={
                <RequireAuth><App /></RequireAuth>
              } />
              <Route path="/workspace/:workspaceId/:artifactType/:artifactId" element={
                <RequireAuth><RedirectStripArtifact /></RequireAuth>
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

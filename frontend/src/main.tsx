import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
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
                  <RedirectToOwnWorkspace />
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

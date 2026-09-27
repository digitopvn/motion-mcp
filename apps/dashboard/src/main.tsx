import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { AppShell } from "./components/app-shell.tsx";
import { BillingPage } from "./pages/billing.tsx";
import { KeysPage } from "./pages/keys.tsx";
import { LoginPage } from "./pages/login.tsx";
import { NotFoundPage } from "./pages/not-found.tsx";
import { OverviewPage } from "./pages/overview.tsx";
import { ProvidersPage } from "./pages/providers.tsx";
import { RecipesPage } from "./pages/recipes.tsx";
import { SearchPage } from "./pages/search.tsx";
import { SettingsPage } from "./pages/settings.tsx";
import { VideoDetailPage } from "./pages/video-detail.tsx";
import { VideoNewPage } from "./pages/video-new.tsx";
import { VideosPage } from "./pages/videos.tsx";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<AppShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="videos" element={<VideosPage />} />
          <Route path="videos/new" element={<VideoNewPage />} />
          <Route path="videos/:id" element={<VideoDetailPage />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="recipes" element={<RecipesPage />} />
          <Route path="keys" element={<KeysPage />} />
          <Route path="providers" element={<ProvidersPage />} />
          <Route path="billing" element={<BillingPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);

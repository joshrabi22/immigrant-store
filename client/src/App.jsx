import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import AppLayout from "./layouts/AppLayout";

// Intake
import SuggestedPage from "./pages/intake/SuggestedPage";
import WatchedPage from "./pages/intake/WatchedPage";
import OrderedPage from "./pages/intake/OrderedPage";
import ReverseImagePage from "./pages/intake/ReverseImagePage";
import WishlistPage from "./pages/intake/WishlistPage";

// Curation
import StagingPage from "./pages/curation/StagingPage";
import StagingDetailPage from "./pages/curation/StagingDetailPage";
import ProcessingPage from "./pages/curation/ProcessingPage";

// Review
import PhotoSuitePage from "./pages/review/PhotoSuitePage";
import ApprovedPage from "./pages/review/ApprovedPage";

// Publish
import LaunchPage from "./pages/publish/LaunchPage";
import LivePage from "./pages/publish/LivePage";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          {/* Default redirect */}
          <Route index element={<Navigate to="/intake/suggested" replace />} />

          {/* Intake */}
          <Route path="intake/suggested" element={<SuggestedPage />} />
          <Route path="intake/watched" element={<WatchedPage />} />
          <Route path="intake/ordered" element={<OrderedPage />} />
          <Route path="intake/reverse-image" element={<ReverseImagePage />} />
          <Route path="intake/wishlist" element={<WishlistPage />} />

          {/* Curation */}
          <Route path="curation/staging" element={<StagingPage />} />
          <Route path="curation/staging/:id" element={<StagingDetailPage />} />
          <Route path="curation/processing" element={<ProcessingPage />} />

          {/* Review */}
          <Route path="review/photo-suite" element={<PhotoSuitePage />} />
          <Route path="review/approved" element={<ApprovedPage />} />

          {/* Publish */}
          <Route path="publish/launch" element={<LaunchPage />} />
          <Route path="publish/live" element={<LivePage />} />

          {/* Catch-all */}
          <Route path="*" element={<Navigate to="/intake/suggested" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

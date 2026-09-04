import React, { Suspense, lazy } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { useAuth } from './store/authStore';
import DashboardLayout from './layouts/DashboardLayout';
import { useLoader } from './components/ui/FullScreenLoader';
import { PageWrapper } from './components/ui/PageWrapper';

// Lazy loaded pages to reduce initial bundle size
const Login = lazy(() => import('./pages/Login'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const EventList = lazy(() => import('./pages/Events/EventList'));
const EventCreate = lazy(() => import('./pages/Events/EventCreate'));
const EventDetail = lazy(() => import('./pages/Events/EventDetail'));
const EventEdit = lazy(() => import('./pages/Events/EventEdit'));
const ContactList = lazy(() => import('./pages/Contacts/ContactList'));
const BulkImport = lazy(() => import('./pages/Contacts/BulkImport'));
const Composer = lazy(() => import('./pages/Campaigns/Composer'));
const SendPreview = lazy(() => import('./pages/Campaigns/SendPreview'));
const CampaignReport = lazy(() => import('./pages/Campaigns/CampaignReport'));
const Reports = lazy(() => import('./pages/Reports'));
const Settings = lazy(() => import('./pages/Settings'));
const Register = lazy(() => import('./pages/Register'));
const UserApprovals = lazy(() => import('./pages/Admin/UserApprovals'));
const JustAccess = lazy(() => import('./pages/Admin/JustAccess'));
const AuditLogs = lazy(() => import('./pages/Admin/AuditLogs'));

const PageLoader = () => (
  <div className="flex items-center justify-center h-[60vh]">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
  </div>
);

const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return <PageLoader />;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
};

// Separate component so useLocation works inside <Router>
function AnimatedRoutes() {
  const location = useLocation();

  return (
    <AnimatePresence mode="wait">
      <Routes location={location} key={location.pathname}>
        <Route path="/login" element={<PageWrapper><Login /></PageWrapper>} />
        <Route path="/register" element={<PageWrapper><Register /></PageWrapper>} />

        <Route
          element={
            <ProtectedRoute>
              <DashboardLayout />
            </ProtectedRoute>
          }
        >
          <Route path="/dashboard" element={<PageWrapper><Dashboard /></PageWrapper>} />
          <Route path="/events" element={<PageWrapper><EventList /></PageWrapper>} />
          <Route path="/events/create" element={<PageWrapper><EventCreate /></PageWrapper>} />
          <Route path="/events/:id" element={<PageWrapper><EventDetail /></PageWrapper>} />
          <Route path="/events/:id/edit" element={<PageWrapper><EventEdit /></PageWrapper>} />
          <Route path="/contacts" element={<PageWrapper><ContactList /></PageWrapper>} />
          <Route path="/contacts/import" element={<PageWrapper><BulkImport /></PageWrapper>} />
          <Route path="/campaigns" element={<PageWrapper><Composer /></PageWrapper>} />
          <Route path="/campaigns/send-preview" element={<PageWrapper><SendPreview /></PageWrapper>} />
          <Route path="/campaigns/:campaignId/report" element={<PageWrapper><CampaignReport /></PageWrapper>} />
          <Route path="/reports" element={<PageWrapper><Reports /></PageWrapper>} />
          <Route path="/settings" element={<PageWrapper><Settings /></PageWrapper>} />
          <Route path="/admin/approvals" element={<PageWrapper><UserApprovals /></PageWrapper>} />
          <Route path="/admin/just-access" element={<PageWrapper><JustAccess /></PageWrapper>} />
          <Route path="/admin/audit-logs" element={<PageWrapper><AuditLogs /></PageWrapper>} />
        </Route>

        <Route path="/" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </AnimatePresence>
  );
}

function App() {
  return (
    <Router>
      <Suspense fallback={<PageLoader />}>
        <AnimatedRoutes />
      </Suspense>
    </Router>
  );
}

export default App;

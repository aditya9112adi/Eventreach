import React, { Suspense, lazy } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './store/authStore';
import DashboardLayout from './layouts/DashboardLayout';
import { useLoader } from './components/ui/FullScreenLoader';

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

function App() {
  return (
    <Router>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          
          <Route
            element={
              <ProtectedRoute>
                <DashboardLayout />
              </ProtectedRoute>
            }
          >
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/events" element={<EventList />} />
            <Route path="/events/create" element={<EventCreate />} />
            <Route path="/events/:id" element={<EventDetail />} />
            <Route path="/events/:id/edit" element={<EventEdit />} />
            <Route path="/contacts" element={<ContactList />} />
            <Route path="/contacts/import" element={<BulkImport />} />
            <Route path="/campaigns" element={<Composer />} />
            <Route path="/campaigns/send-preview" element={<SendPreview />} />
            <Route path="/campaigns/:campaignId/report" element={<CampaignReport />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/admin/approvals" element={<UserApprovals />} />
            <Route path="/admin/just-access" element={<JustAccess />} />
          </Route>
          
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </Suspense>
    </Router>
  );
}

export default App;


import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './store/authStore';
import Login from './pages/Login';
import DashboardLayout from './layouts/DashboardLayout';
import Dashboard from './pages/Dashboard';
import EventList from './pages/Events/EventList';
import EventCreate from './pages/Events/EventCreate';
import EventDetail from './pages/Events/EventDetail';
import ContactList from './pages/Contacts/ContactList';
import BulkImport from './pages/Contacts/BulkImport';
import Composer from './pages/Campaigns/Composer';
import SendPreview from './pages/Campaigns/SendPreview';
import CampaignReport from './pages/Campaigns/CampaignReport';
import Settings from './pages/Settings';
import Register from './pages/Register';
import UserApprovals from './pages/Admin/UserApprovals';
import ReportAccess from './pages/Admin/ReportAccess';

const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
};

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/login" element={<Login />} />
        
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
          <Route path="/contacts" element={<ContactList />} />
          <Route path="/contacts/import" element={<BulkImport />} />
          <Route path="/campaigns" element={<Composer />} />
          <Route path="/campaigns/send-preview" element={<SendPreview />} />
          <Route path="/campaigns/:campaignId/report" element={<CampaignReport />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/admin/approvals" element={<UserApprovals />} />
          <Route path="/admin/report-access" element={<ReportAccess />} />
        </Route>
        
        <Route path="/register" element={<Register />} />
        
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Router>
  );
}

export default App;

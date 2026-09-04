import { useState, useEffect } from 'react';
import { useLocation, useNavigate, NavLink, Outlet } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAuth } from '../store/authStore';
import { useSocket } from '../contexts/SocketContext';
import api from '../services/api';
import { 
  LayoutDashboard, 
  CalendarDays, 
  Users, 
  Megaphone, 
  LogOut, 
  Menu, 
  X,
  MessageSquare,
  Settings,
  Sun,
  Moon,
  PieChart,
  Shield
} from 'lucide-react';
import { useTheme } from '../store/themeStore';

const DashboardLayout = () => {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const location = useLocation();
  const navigate = useNavigate();
  const { socket, isConnected } = useSocket();

  useEffect(() => {
    const currentId = user?.id || (user as any)?._id;
    if (socket && isConnected && currentId) {
      console.log('Emitting identify for user:', currentId);
      socket.emit('identify', currentId);
    }
  }, [socket, isConnected, user]);

  useEffect(() => {
    if (!socket) return;
    
    const handleAccessEvent = (data: { message: string }) => {
      console.log('Received access event:', data);
      logout();
      navigate('/login', { state: { message: data.message } });
    };

    socket.on('ACCESS_REMOVED', handleAccessEvent);
    socket.on('ACCESS_EXPIRED', handleAccessEvent);

    return () => {
      socket.off('ACCESS_REMOVED', handleAccessEvent);
      socket.off('ACCESS_EXPIRED', handleAccessEvent);
    };
  }, [socket, logout, navigate]);

  useEffect(() => {
    if (user?.role === 'SuperAdmin') {
      api.get('/admin/users/pending')
        .then(res => setPendingCount(res.data.length))
        .catch(console.error);
    }
  }, [user, location.pathname]);

  const navItems = [
    { name: 'Dashboard', to: '/dashboard', icon: LayoutDashboard },
    { name: 'Events', to: '/events', icon: CalendarDays },
    { name: 'Guests', to: '/contacts', icon: Users },
    { name: 'Campaigns', to: '/campaigns', icon: Megaphone },
    { name: 'Reports', to: '/reports', icon: PieChart },
  ];

  if (user?.role === 'SuperAdmin') {
    navItems.push({ name: 'User Approvals', to: '/admin/approvals', icon: Users });
    navItems.push({ name: 'Just Access', to: '/admin/just-access', icon: MessageSquare });
    navItems.push({ name: 'Audit Logs', to: '/admin/audit-logs', icon: Shield });
    navItems.push({ name: 'Settings', to: '/settings', icon: Settings });
  }

  return (
    <div className="min-h-screen flex text-foreground">
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div 
          className="fixed inset-0 z-40 bg-background/40 backdrop-blur-md lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`
        fixed inset-y-0 left-0 z-50 w-64 bg-surface border-r border-border transition-transform duration-300 ease-in-out lg:static lg:translate-x-0
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
        <div className="h-16 flex items-center px-6 border-b border-border">
          <img src={theme === 'dark' ? '/logo-dark.png' : '/logo.png'} alt="Events By Occasion" className="w-8 h-8 mr-3 object-contain dark:drop-shadow-sm mix-blend-multiply dark:mix-blend-normal" />
          <span className="text-xl font-sans font-bold tracking-tighter uppercase truncate" title="Events By Occasion">Events By Occasion</span>
          <button 
            className="ml-auto lg:hidden text-foreground/50 hover:text-foreground"
            onClick={() => setSidebarOpen(false)}
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        <nav className="p-4 space-y-1 relative">
          {navItems.map((item) => (
            <NavLink
              key={item.name}
              to={item.to}
              onClick={() => setSidebarOpen(false)}
              className={({ isActive }) => `
                relative flex items-center px-4 py-3 text-sm font-bold tracking-wide uppercase transition-colors duration-300 rounded-md outline-none
                ${isActive 
                  ? 'text-accent' 
                  : 'text-foreground/50 hover:bg-white/5 hover:text-foreground'
                }
              `}
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <motion.div
                      layoutId="sidebar-active-indicator"
                      className="absolute inset-0 bg-accent/10 rounded-md z-0"
                      initial={false}
                      transition={{ type: "spring", stiffness: 350, damping: 30 }}
                    />
                  )}
                  <div className="relative z-10 flex items-center w-full">
                    <item.icon className={`w-5 h-5 mr-3 flex-shrink-0 transition-colors duration-300 ${isActive ? 'text-accent' : 'text-foreground/40'}`} />
                    {item.name}
                    {item.name === 'User Approvals' && pendingCount > 0 && (
                      <span className="ml-auto bg-accent text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
                        {pendingCount}
                      </span>
                    )}
                  </div>
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-border">
          <div className="flex items-center">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">
                {user?.email}
              </p>
            </div>
            <button
              onClick={toggleTheme}
              className="ml-2 p-2 text-foreground/50 hover:text-foreground hover:bg-foreground/5 rounded-md transition-colors"
              title="Toggle Theme"
            >
              {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
            <button
              onClick={logout}
              className="ml-2 p-2 text-foreground/50 hover:text-destructive hover:bg-destructive/10 rounded-md transition-colors"
              title="Logout"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 relative z-10 bg-background">
        <header className="bg-surface border-b border-border lg:hidden sticky top-0 z-30">
          <div className="flex items-center justify-between px-4 h-16">
            <div className="flex items-center min-w-0">
              <img src={theme === 'dark' ? '/logo-dark.png' : '/logo.png'} alt="Events By Occasion" className="w-6 h-6 mr-2 object-contain dark:drop-shadow-sm mix-blend-multiply dark:mix-blend-normal" />
              <span className="text-lg font-sans font-bold text-foreground uppercase tracking-tighter truncate">Events By Occasion</span>
            </div>
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-2 text-foreground/50 hover:text-foreground hover:bg-foreground/5 rounded-md"
            >
              <Menu className="w-6 h-6" />
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-auto no-scrollbar">
          <div className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
};

export default DashboardLayout;

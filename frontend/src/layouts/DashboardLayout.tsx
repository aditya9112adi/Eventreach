import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../store/authStore';
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
  Moon
} from 'lucide-react';
import { useTheme } from '../store/themeStore';

const DashboardLayout = () => {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const navItems = [
    { name: 'Dashboard', to: '/dashboard', icon: LayoutDashboard },
    { name: 'Events', to: '/events', icon: CalendarDays },
    { name: 'Contacts', to: '/contacts', icon: Users },
    { name: 'Campaigns', to: '/campaigns', icon: Megaphone },
    { name: 'Settings', to: '/settings', icon: Settings },
  ];

  if (user?.role === 'SuperAdmin') {
    navItems.push({ name: 'User Approvals', to: '/admin/approvals', icon: Users });
    navItems.push({ name: 'Report Access', to: '/admin/report-access', icon: MessageSquare });
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
          <img src="/logo.jpg" alt="EventReach" className="w-8 h-8 mr-3 object-contain bg-white rounded-md p-1" />
          <span className="text-xl font-sans font-bold tracking-tighter uppercase">EventReach</span>
          <button 
            className="ml-auto lg:hidden text-foreground/50 hover:text-foreground"
            onClick={() => setSidebarOpen(false)}
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        <nav className="p-4 space-y-1">
          {navItems.map((item) => (
            <NavLink
              key={item.name}
              to={item.to}
              onClick={() => setSidebarOpen(false)}
              className={({ isActive }) => `
                flex items-center px-4 py-3 text-sm font-bold tracking-wide uppercase transition-all duration-300
                ${isActive 
                  ? 'bg-accent/10 text-accent' 
                  : 'text-foreground/50 hover:bg-white/5 hover:text-foreground'
                }
              `}
            >
              {({ isActive }) => (
                <>
                  <item.icon className={`w-5 h-5 mr-3 flex-shrink-0 ${isActive ? 'text-accent' : 'text-foreground/40'}`} />
                  {item.name}
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
            <div className="flex items-center">
              <img src="/logo.jpg" alt="EventReach" className="w-6 h-6 mr-2 object-contain bg-white rounded p-0.5" />
              <span className="text-lg font-sans font-bold text-foreground uppercase tracking-tighter">EventReach</span>
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

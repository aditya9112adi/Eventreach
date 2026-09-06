import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, NavLink, Outlet } from 'react-router-dom';
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
  Shield,
  KeyRound,
  ChevronsLeft,
  ChevronsRight,
  ChevronDown,
  type LucideIcon,
} from 'lucide-react';
import { useTheme } from '../store/themeStore';
import { useToast } from '../components/ui/Toast';
import { Dropdown, type DropdownItem } from '../components/ui/Dropdown';

interface NavItem {
  name: string;
  to: string;
  icon: LucideIcon;
  /** Renders a live count pill on the right of the row. */
  badge?: number;
  /** Only match the route exactly (used for index-style routes). */
  end?: boolean;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

/** Human page titles for the header, longest prefix wins. */
const PAGE_TITLES: Array<[string, string]> = [
  ['/dashboard', 'Dashboard'],
  ['/events/create', 'Create Event'],
  ['/events', 'Events'],
  ['/contacts/import', 'Bulk Import'],
  ['/contacts', 'Guests'],
  ['/campaigns/send-preview', 'Send Preview'],
  ['/campaigns', 'Campaigns'],
  ['/reports', 'Reports'],
  ['/change-password', 'Change Password'],
  ['/settings', 'Settings'],
  ['/admin/approvals', 'User Approvals'],
  ['/admin/just-access', 'Just Access'],
  ['/admin/audit-logs', 'Audit Logs'],
];

const titleForPath = (pathname: string): string => {
  const match = PAGE_TITLES.filter(([prefix]) => pathname.startsWith(prefix)).sort(
    (a, b) => b[0].length - a[0].length
  )[0];
  if (match) return match[1];
  if (/^\/campaigns\/[^/]+\/report/.test(pathname)) return 'Campaign Report';
  if (/^\/events\/[^/]+\/edit/.test(pathname)) return 'Edit Event';
  if (/^\/events\/[^/]+/.test(pathname)) return 'Event Details';
  return 'EventReach';
};

const SIDEBAR_STORAGE_KEY = 'eventreach.sidebar.collapsed';

const initials = (value?: string) =>
  (value || '?')
    .replace(/@.*$/, '')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || '?';

const DashboardLayout = () => {
  const { user, logout, updateUser } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { showToast } = useToast();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1'
  );
  const [pendingCount, setPendingCount] = useState(0);
  const location = useLocation();
  const navigate = useNavigate();
  const { socket, isConnected } = useSocket();

  useEffect(() => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const currentId = user?.id || (user as any)?._id;
    if (socket && isConnected && currentId) {
      socket.emit('identify', currentId);
    }
  }, [socket, isConnected, user]);

  useEffect(() => {
    if (!socket) return;

    const handleAccessEvent = (data: { message: string }) => {
      logout();
      navigate('/login', { state: { message: data.message } });
    };

    const handleEventAssignment = (data: {
      assignedEventId: string | null;
      eventName: string | null;
    }) => {
      updateUser({
        assignedEventId: data.assignedEventId || undefined,
        assignedEventName: data.eventName || undefined,
      });

      if (data.eventName) {
        showToast('info', `Your assigned event has been updated to "${data.eventName}"`);
      } else {
        showToast('info', 'Your event assignment has been removed.');
      }

      // If currently on an event page that is not the newly assigned event, redirect
      const eventPathMatch = location.pathname.match(/\/events\/([a-zA-Z0-9]+)/);
      if (eventPathMatch && eventPathMatch[1] !== data.assignedEventId) {
        if (data.assignedEventId) {
          navigate(`/events/${data.assignedEventId}`);
        } else {
          navigate('/dashboard');
        }
      }
    };

    socket.on('ACCESS_REMOVED', handleAccessEvent);
    socket.on('ACCESS_EXPIRED', handleAccessEvent);
    socket.on('EVENT_ASSIGNMENT_CHANGED', handleEventAssignment);

    return () => {
      socket.off('ACCESS_REMOVED', handleAccessEvent);
      socket.off('ACCESS_EXPIRED', handleAccessEvent);
      socket.off('EVENT_ASSIGNMENT_CHANGED', handleEventAssignment);
    };
  }, [socket, logout, navigate, updateUser, showToast, location.pathname]);

  useEffect(() => {
    if (user?.role === 'SuperAdmin') {
      api
        .get('/admin/users/pending')
        .then((res) => setPendingCount(res.data.length))
        .catch(() => {
          /* the socket push below is the live source; a failed poll is not fatal */
        });
    }
  }, [user, location.pathname]);

  // Live "User Approvals" badge. The server pushes a fresh count to every
  // connected Super Admin whenever someone registers or a request is approved or
  // rejected, so the badge appears and clears without navigating or refreshing.
  useEffect(() => {
    if (!socket || user?.role !== 'SuperAdmin') return;

    const handlePendingChanged = (data: { pendingCount: number }) => {
      setPendingCount(data.pendingCount);
    };

    socket.on('PENDING_APPROVALS_CHANGED', handlePendingChanged);
    return () => {
      socket.off('PENDING_APPROVALS_CHANGED', handlePendingChanged);
    };
  }, [socket, user?.role]);

  const sections: NavSection[] = useMemo(() => {
    const result: NavSection[] = [
      {
        label: 'Workspace',
        items: [
          { name: 'Dashboard', to: '/dashboard', icon: LayoutDashboard },
          { name: 'Events', to: '/events', icon: CalendarDays },
          { name: 'Guests', to: '/contacts', icon: Users },
          { name: 'Campaigns', to: '/campaigns', icon: Megaphone },
          { name: 'Reports', to: '/reports', icon: PieChart },
        ],
      },
    ];

    // Administration is Super Admin only, matching the existing route guards.
    if (user?.role === 'SuperAdmin') {
      result.push({
        label: 'Administration',
        items: [
          { name: 'User Approvals', to: '/admin/approvals', icon: Users, badge: pendingCount },
          { name: 'Just Access', to: '/admin/just-access', icon: MessageSquare },
          { name: 'Audit Logs', to: '/admin/audit-logs', icon: Shield },
          { name: 'Settings', to: '/settings', icon: Settings },
        ],
      });
    }

    result.push({
      label: 'Account',
      items: [{ name: 'Change Password', to: '/change-password', icon: KeyRound }],
    });

    return result;
  }, [user?.role, pendingCount]);

  const pageTitle = titleForPath(location.pathname);

  const profileItems: DropdownItem[] = [
    {
      label: 'Change password',
      icon: KeyRound,
      onSelect: () => navigate('/change-password'),
    },
    ...(user?.role === 'SuperAdmin'
      ? [{ label: 'Settings', icon: Settings, onSelect: () => navigate('/settings') }]
      : []),
    {
      label: theme === 'dark' ? 'Light theme' : 'Dark theme',
      icon: theme === 'dark' ? Sun : Moon,
      onSelect: toggleTheme,
    },
    { label: 'Sign out', icon: LogOut, onSelect: logout, destructive: true, separated: true },
  ];

  const sidebarWidth = collapsed ? 'lg:w-[4.5rem]' : 'lg:w-64';

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* Mobile drawer scrim */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-950/40 backdrop-blur-[2px] animate-fade-in lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={[
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-border bg-surface',
          'transition-transform duration-surface ease-out-expo lg:static lg:translate-x-0',
          'lg:transition-[width] lg:duration-surface',
          sidebarWidth,
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        ].join(' ')}
      >
        {/* Brand */}
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-4">
          <img
            src={theme === 'dark' ? '/logo-dark.png' : '/logo.png'}
            alt=""
            className="h-7 w-7 shrink-0 object-contain mix-blend-multiply dark:mix-blend-normal"
          />
          {!collapsed && (
            <span className="truncate text-sm font-semibold tracking-tight text-foreground">
              Events By Occasion
            </span>
          )}
          <button
            type="button"
            className="ml-auto rounded-md p-1.5 text-muted transition-colors duration-micro hover:bg-surfaceHover hover:text-foreground lg:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close navigation"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4" aria-label="Main">
          {sections.map((section) => (
            <div key={section.label}>
              {!collapsed && <p className="label-caption px-3 pb-2">{section.label}</p>}
              <div className="space-y-0.5">
                {section.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    title={collapsed ? item.name : undefined}
                    className={({ isActive }) =>
                      [
                        'group relative flex items-center rounded-lg text-sm font-medium',
                        'transition-colors duration-micro',
                        collapsed ? 'justify-center px-0 py-2.5' : 'gap-3 px-3 py-2',
                        isActive
                          ? 'bg-primary/10 text-primary'
                          : 'text-muted hover:bg-surfaceHover hover:text-foreground',
                      ].join(' ')
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {/* Active rail: a cheap, layout-free replacement for the
                            spring-animated highlight this sidebar used before. */}
                        {isActive && (
                          <span
                            className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary"
                            aria-hidden="true"
                          />
                        )}
                        <item.icon className="h-4.5 w-4.5 shrink-0" aria-hidden="true" />
                        {!collapsed && <span className="truncate">{item.name}</span>}
                        {typeof item.badge === 'number' && item.badge > 0 && (
                          <span
                            className={[
                              'flex h-5 min-w-[1.25rem] items-center justify-center rounded-full',
                              'bg-primary px-1.5 text-caption font-semibold text-primary-foreground',
                              collapsed ? 'absolute -right-0.5 -top-0.5 h-4 min-w-[1rem]' : 'ml-auto',
                            ].join(' ')}
                            aria-label={`${item.badge} pending`}
                          >
                            {item.badge > 99 ? '99+' : item.badge}
                          </span>
                        )}
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* Collapse toggle — desktop only; the drawer already has a close button. */}
        <div className="hidden shrink-0 border-t border-border p-2 lg:block">
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={[
              'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-muted',
              'transition-colors duration-micro hover:bg-surfaceHover hover:text-foreground',
              collapsed ? 'justify-center px-0' : '',
            ].join(' ')}
          >
            {collapsed ? (
              <ChevronsRight className="h-4 w-4" aria-hidden="true" />
            ) : (
              <>
                <ChevronsLeft className="h-4 w-4" aria-hidden="true" />
                Collapse
              </>
            )}
          </button>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface/85 px-4 backdrop-blur-md sm:px-6">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open navigation"
            className="-ml-1 rounded-md p-2 text-muted transition-colors duration-micro hover:bg-surfaceHover hover:text-foreground lg:hidden"
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>

          <h1 className="min-w-0 flex-1 truncate text-md font-semibold text-foreground">
            {pageTitle}
          </h1>

          <button
            type="button"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            className="rounded-md p-2 text-muted transition-colors duration-micro hover:bg-surfaceHover hover:text-foreground"
          >
            {theme === 'dark' ? (
              <Sun className="h-4.5 w-4.5" aria-hidden="true" />
            ) : (
              <Moon className="h-4.5 w-4.5" aria-hidden="true" />
            )}
          </button>

          <Dropdown
            items={profileItems}
            header={
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {user?.name || user?.email}
                </p>
                <p className="truncate text-xs text-muted">{user?.role}</p>
              </div>
            }
            trigger={
              <span className="flex items-center gap-2 rounded-lg py-1 pl-1 pr-1.5 transition-colors duration-micro hover:bg-surfaceHover">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-caption font-semibold text-primary-foreground">
                  {initials(user?.name || user?.email)}
                </span>
                <span className="hidden max-w-[10rem] truncate text-sm font-medium text-foreground sm:block">
                  {user?.name || user?.email}
                </span>
                <ChevronDown className="h-4 w-4 text-muted" aria-hidden="true" />
              </span>
            }
          />
        </header>

        <main className="flex-1">
          <div className="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
};

export default DashboardLayout;

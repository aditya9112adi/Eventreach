/**
 * The application footer, rendered once by DashboardLayout so every
 * authenticated page gets it without adding anything per page.
 *
 * It is part of the scrolling content rather than fixed to the viewport: a
 * fixed footer would sit on top of long pages, and the tables in this
 * application are long. DashboardLayout gives the content area `flex-1`, which
 * is what keeps this at the bottom on a short page without pinning it.
 *
 * The two halves share a row on desktop and stack on a phone, so neither text
 * is ever the cause of horizontal overflow.
 */
export const AppFooter = () => (
  <footer className="border-t border-border px-4 py-4 sm:px-6 lg:px-8">
    <div className="mx-auto flex max-w-7xl flex-col gap-1 text-xs text-foreground/40 sm:flex-row sm:items-center sm:justify-between">
      <span>© 2026, Event Reach</span>
      <span>Powered by SmartestStack</span>
    </div>
  </footer>
);
